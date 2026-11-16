/**
 * The one description of a Blaze dynamic value.
 *
 * The C header, the Nim adapter and the wasm host all state the same 16-byte
 * record and the same numbers for its tags and handle kinds. They are written
 * from the tables here rather than copied by hand, because a constant that
 * disagrees between two runtimes turns a valid value into a type error on only
 * one of them. The prose specification is docs/specs/value-abi.md.
 */

/** The tag of a value, kept out of the payload so a double keeps all its bits. */
export const VALUE_TAGS = {
  number: 0,
  boolean: 1,
  null: 2,
  handle: 3,
  external: 4,
} as const;

/** What a handle points at. A registry entry carries the same number. */
export const HANDLE_KINDS = {
  string: 1,
  record: 2,
  array: 3,
  object: 4,
  closure: 5,
  buffer: 6,
  /* The kinds a value the runtime boxes for a program holds. They are handle
     kinds like any other, not a second numbering scheme in the same slot. */
  number: 7,
  boolean: 8,
  nil: 9,
  dictionary: 10,
} as const;

/** What an external value owns. A resource entry carries the same number. */
export const EXTERNAL_KINDS = {
  sqlite: 1,
  file: 2,
  ffi: 3,
  md5: 4,
  sha256: 5,
  promise: 6,
} as const;

/** The state and ownership bits of a registry entry. */
export const ENTRY_STATE = { live: 1, released: 0 } as const;
export const ENTRY_OWNERSHIP = { owned: 0, external: 1 } as const;

/** The byte layout every backend gives a value. */
export const VALUE_LAYOUT = {
  payload: { offset: 0, bytes: 8 },
  tag: { offset: 8, bytes: 4 },
  kind: { offset: 12, bytes: 4 },
  bytes: 16,
} as const;

/** The number of index bits in a handle, and the mask of its index half. */
export const HANDLE_INDEX_BITS = 32;
export const HANDLE_INDEX_MASK = 0xffffffffn;

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** The values of a numbered table, in declaration order. */
function numbersOf(table: Record<string, number>): number[] {
  const out: number[] = [];
  for (const name of Object.keys(table)) out.push(Number(fieldOf(table, name)));
  return out;
}

/** True when a number names one of the members of a table. */
function hasValue(table: Record<string, number>, value: number): boolean {
  for (const known of numbersOf(table)) if (known === value) return true;
  return false;
}

/** Whether a number is a tag this ABI defines. */
export function isValueTag(value: number): boolean {
  return hasValue(VALUE_TAGS, value);
}

/** Whether a number is a handle subtype this ABI defines. */
export function isHandleKind(value: number): boolean {
  return hasValue(HANDLE_KINDS, value);
}

/** Whether a number is an external resource type this ABI defines. */
export function isExternalKind(value: number): boolean {
  return hasValue(EXTERNAL_KINDS, value);
}

/**
 * The payload of a handle: its slot index in the low half and the generation
 * of the slot in the high half. A stale handle therefore never resolves to an
 * object allocated after the one it named was released.
 */
export function handlePayload(index: number, generation: number): bigint {
  return (BigInt(generation) << BigInt(HANDLE_INDEX_BITS)) | (BigInt(index) & HANDLE_INDEX_MASK);
}

/** The slot index a handle payload names. */
export function handleIndexOf(payload: bigint): number {
  return Number(payload & HANDLE_INDEX_MASK);
}

/** The generation a handle payload carries. */
export function handleGenerationOf(payload: bigint): number {
  return Number(payload >> BigInt(HANDLE_INDEX_BITS));
}

/** The C declaration of the value, its constants and its validating accessors. */
export function valueAbiCDeclaration(): string {
  const tags = Object.keys(VALUE_TAGS).map((name) => {
    return `  BLAZE_VALUE_${name.toUpperCase()} = ${String(fieldOf(VALUE_TAGS, name))}`;
  });
  const kinds = Object.keys(HANDLE_KINDS).map((name) => {
    return `  BLAZE_HANDLE_${name.toUpperCase()} = ${String(fieldOf(HANDLE_KINDS, name))}`;
  });
  const resources = Object.keys(EXTERNAL_KINDS).map((name) => {
    return `  BLAZE_EXTERNAL_${name.toUpperCase()} = ${String(fieldOf(EXTERNAL_KINDS, name))}`;
  });
  return `/* The tagged dynamic value. Generated from runtime/value-abi.ts. */
typedef enum {
${tags.join(",\n")}
} BlazeValueTag;

typedef enum {
${kinds.join(",\n")}
} BlazeHandleKind;

typedef enum {
${resources.join(",\n")}
} BlazeExternalKind;

typedef struct {
  /* The IEEE-754 bits of a number, or the index and generation of a handle. */
  uint64_t payload;
  uint32_t tag;
  uint32_t kind;
} BlazeValue;

#define BLAZE_VALUE_BYTES ${String(VALUE_LAYOUT.bytes)}u
#define BLAZE_HANDLE_INDEX_BITS ${String(HANDLE_INDEX_BITS)}u

#define BLAZE_ENTRY_LIVE ${String(ENTRY_STATE.live)}u
#define BLAZE_ENTRY_RELEASED ${String(ENTRY_STATE.released)}u
#define BLAZE_ENTRY_OWNED ${String(ENTRY_OWNERSHIP.owned)}u
#define BLAZE_ENTRY_EXTERNAL ${String(ENTRY_OWNERSHIP.external)}u

static inline BlazeValue blaze_value_number(double number) {
  BlazeValue value;
  memcpy(&value.payload, &number, sizeof number);
  value.tag = BLAZE_VALUE_NUMBER;
  value.kind = 0;
  return value;
}

static inline BlazeValue blaze_value_boolean(int truth) {
  BlazeValue value;
  value.payload = truth ? 1ULL : 0ULL;
  value.tag = BLAZE_VALUE_BOOLEAN;
  value.kind = 0;
  return value;
}

static inline BlazeValue blaze_value_null(void) {
  BlazeValue value;
  value.payload = 0;
  value.tag = BLAZE_VALUE_NULL;
  value.kind = 0;
  return value;
}

static inline BlazeValue blaze_value_handle(uint32_t kind, uint32_t index, uint32_t generation) {
  BlazeValue value;
  value.payload = ((uint64_t)generation << BLAZE_HANDLE_INDEX_BITS) | index;
  value.tag = BLAZE_VALUE_HANDLE;
  value.kind = kind;
  return value;
}

static inline int blaze_value_is(const BlazeValue* value, uint32_t tag) {
  return value->tag == tag;
}

static inline int blaze_value_is_handle(const BlazeValue* value, uint32_t kind) {
  return value->tag == BLAZE_VALUE_HANDLE && value->kind == kind;
}

static inline uint32_t blaze_value_index(const BlazeValue* value) {
  return (uint32_t)(value->payload & 0xffffffffULL);
}

static inline uint32_t blaze_value_generation(const BlazeValue* value) {
  return (uint32_t)(value->payload >> BLAZE_HANDLE_INDEX_BITS);
}

/* The bridge for a lowering that still carries a dynamic value in a double:
   the payload is the handle the registry gave the value, or the bits of the
   number it holds. Both directions are defined by the runtime, where the
   registry lives. */
BlazeValue blaze_value_from_dynamic(double value);
double blaze_dynamic_from_value(BlazeValue value);
/* A C string the compiler wrote out, carried as an external-buffer string. */
BlazeValue blaze_value_c_text(const char* text);
/* A reference a lowering holds as a pointer, carried as a typed handle. */
double blaze_value_ref(void* pointer);
/* A managed string pointer as the tagged value the ABI carries. */
BlazeValue blaze_value_from_text(const char* text);

static inline double blaze_value_number_of(const BlazeValue* value) {
  double number = 0.0;
  if (value->tag != BLAZE_VALUE_NUMBER) return number;
  memcpy(&number, &value->payload, sizeof number);
  return number;
}
`;
}

/** The Nim declaration of the same record, with the same field order. */
export function valueAbiNimDeclaration(): string {
  const tags = Object.keys(VALUE_TAGS).map((name) => {
    return `  BlazeTag${name.slice(0, 1).toUpperCase()}${name.slice(1)} = ${String(fieldOf(VALUE_TAGS, name))}`;
  });
  const kinds = Object.keys(HANDLE_KINDS).map((name) => {
    return `  BlazeKind${name.slice(0, 1).toUpperCase()}${name.slice(1)} = ${String(fieldOf(HANDLE_KINDS, name))}`;
  });
  const resources = Object.keys(EXTERNAL_KINDS).map((name) => {
    return `  BlazeExternal${name.slice(0, 1).toUpperCase()}${name.slice(1)} = ${String(fieldOf(EXTERNAL_KINDS, name))}`;
  });
  return `# Generated from runtime/value-abi.ts.
type
  BlazeValueTag {.size: sizeof(uint32).} = enum
${tags.join(",\n")}
  BlazeHandleKind {.size: sizeof(uint32).} = enum
${kinds.join(",\n")}
  BlazeExternalKind {.size: sizeof(uint32).} = enum
${resources.join(",\n")}
  BlazeValue {.packed.} = object
    payload: uint64
    tag: uint32
    kind: uint32
`;
}

/** The wasm constants and linear-memory layout of the same record. */
export function valueAbiWasmDeclaration(): string {
  const tags = Object.keys(VALUE_TAGS).map((name) => {
    return `export const VALUE_${name.toUpperCase()} = ${String(fieldOf(VALUE_TAGS, name))};`;
  });
  const kinds = Object.keys(HANDLE_KINDS).map((name) => {
    return `export const HANDLE_${name.toUpperCase()} = ${String(fieldOf(HANDLE_KINDS, name))};`;
  });
  return `// Generated from runtime/value-abi.ts.
// A value in linear memory is an i64 payload, an i32 tag and an i32 kind.
${tags.join("\n")}
${kinds.join("\n")}
export const VALUE_BYTES = ${String(VALUE_LAYOUT.bytes)};
export const VALUE_PAYLOAD_OFFSET = ${String(fieldOf(fieldOf(VALUE_LAYOUT, "payload"), "offset"))};
export const VALUE_TAG_OFFSET = ${String(fieldOf(fieldOf(VALUE_LAYOUT, "tag"), "offset"))};
export const VALUE_KIND_OFFSET = ${String(fieldOf(fieldOf(VALUE_LAYOUT, "kind"), "offset"))};
`;
}
