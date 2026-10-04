// secp256k1 scalar multiplication, as a machine backend benchmark.
//
// The algorithm is the one in
// https://github.com/paulmillr/noble-secp256k1/blob/main/index.ts: a private
// key multiplied into the generator's point, in Jacobian coordinates, with the
// fast formulas a curve whose a is zero allows. What it is written in here is
// what the compiler reads, which is a narrower thing than what noble is
// written in:
//
//   - A point is three field values in three buffers rather than a class,
//     because a program cannot allocate one. The formulas, the double-and-add,
//     and the conversion back to affine coordinates are the ones above.
//
//   - A field value is eleven 24 bit limbs rather than a 256 bit integer. A
//     limb product is below 2^48 and a limb sum below 2^53, so every operation
//     here is exact in a double and is the same operation the compiler emits;
//     eleven limbs carry 264 bits, which is the 256 the curve needs and eight
//     bits more. The compiler's own `u256` is four limbs in the frame and
//     reaches no division, so the modular multiplication below is the
//     double-and-add a 256 bit machine cannot do in one instruction, over the
//     bits of the multiplicand. That is why this benchmark is slow, and not
//     why it is wrong.
//
//   - The scalar is not split by the endomorphism. `splitScalarEndo` divides a
//     512 bit product by the group order, which is a division over four limbs
//     no machine here has an instruction for, so the scalar is multiplied in
//     plain double-and-add: a longer route to the same point, which is the
//     whole of what the endomorphism is - fewer operations, same answer.
//
//   - The result is printed as its limbs rather than as one coordinate. A 256
//     bit value has no form both this program and node's own run of this file
//     can agree on, because node holds these values as doubles, and a build
//     compares the two outputs exactly; so a coordinate printed as a whole
//     number could never be checked. The limbs are exact in both. The value is
//     read back as base 2^24, most significant limb first.
//
// A function here is given every buffer it works in, because a buffer's bound
// has to be one the contract can name: a loop over `o[i]` where `i` is a
// parameter or a literal is a length the caller is held to, and an index built
// from an offset is not. So a value is a buffer of twelve limbs - the twelfth
// being the carry an addition makes - and a point is three of them passed
// beside each other. The three numbers that follow are written out rather than
// named for the same reason: a module-level declaration ahead of the first
// function is a program statement, and takes the file out of the module the
// compiler compiles one function at a time.

/** The prime of secp256k1, 2^256 - 2^32 - 977, in base 2^24, lowest limb first. */
function setPrime(p: Float64Array): void {
    p[0] = 16776239;
    p[1] = 16776959;
    p[2] = 16777215;
    p[3] = 16777215;
    p[4] = 16777215;
    p[5] = 16777215;
    p[6] = 16777215;
    p[7] = 16777215;
    p[8] = 16777215;
    p[9] = 16777215;
    p[10] = 65535;
    p[11] = 0;
}

/** The prime less two, which is the exponent that inverts a value by Fermat. */
function setPrimeMinusTwo(e: Float64Array): void {
    setPrime(e);
    e[0] = 16776237;
}

/** The x of the generator, the official secp256k1 G. */
function setGeneratorX(v: Float64Array): void {
    v[0] = 16258968;
    v[1] = 8477462;
    v[2] = 14244338;
    v[3] = 3001896;
    v[4] = 10222811;
    v[5] = 722690;
    v[6] = 9817735;
    v[7] = 5611618;
    v[8] = 14465964;
    v[9] = 6717177;
    v[10] = 31166;
    v[11] = 0;
}

/** The y of the generator, the official secp256k1 G. */
function setGeneratorY(v: Float64Array): void {
    v[0] = 1103032;
    v[1] = 13668347;
    v[2] = 1678407;
    v[3] = 10913108;
    v[4] = 1553480;
    v[5] = 567549;
    v[6] = 16518673;
    v[7] = 6137083;
    v[8] = 10732645;
    v[9] = 14317350;
    v[10] = 18490;
    v[11] = 0;
}

/** The private key the benchmark multiplies by, which is noble's example key. */
function setPrivateKey(v: Float64Array): void {
    v[0] = 12351123;
    v[1] = 2977973;
    v[2] = 14342419;
    v[3] = 16648880;
    v[4] = 4559587;
    v[5] = 5060790;
    v[6] = 16347391;
    v[7] = 5229118;
    v[8] = 2636860;
    v[9] = 9597049;
    v[10] = 11758;
    v[11] = 0;
}

/** The 24 powers of two a bit of a limb is read at, so no shift is written down. */
function setPowers(powers: Float64Array): void {
    let value = 1;
    for (let i = 0; i < 24; i++) {
        powers[i] = value;
        value = value * 2;
    }
}

/** Every limb of a value is zero. */
function fZero(o: Float64Array): void {
    for (let i = 0; i < 11; i++) {
        o[i] = 0;
    }
    o[11] = 0;
}

/** One field value into another. */
function fCopy(o: Float64Array, a: Float64Array): void {
    for (let i = 0; i < 12; i++) {
        o[i] = a[i];
    }
}

/** Whether a field value is zero, which is what the point at infinity is. */
function fIsZero(v: Float64Array): boolean {
    let answer: boolean = true;
    for (let i = 0; i < 11; i++) {
        if (v[i] !== 0) {
            answer = false;
        }
    }
    return answer;
}

/**
 * -1, 0 or 1 as `a` is below, equal to, or above `b`.
 *
 * The limbs are read from the top down, because the top limb holds the most
 * significant bits: the first limb that differs decides the answer, and no limb
 * below it can change it.
 */
function fCmp(a: Float64Array, b: Float64Array): number {
    let answer = 0;
    for (let i = 10; i >= 0; i--) {
        if (answer === 0) {
            if (a[i] > b[i]) {
                answer = 1;
            }
            if (a[i] < b[i]) {
                answer = -1;
            }
        }
    }
    return answer;
}

/**
 * A sum below the prime, taken once back below it.
 *
 * Both sides are below the prime, so the sum is below twice it and one
 * subtraction is the whole of the reduction. The sum that carried out of the
 * eleventh limb is the case a reduction comparing only the limbs would miss,
 * and the twelfth limb is what says it happened.
 *
 * The sum is written into `o` and reduced in place, so a value may be added to
 * itself and a running sum may be added into.
 */
function fAddMod(o: Float64Array, a: Float64Array, b: Float64Array, m: Float64Array): void {
    let carry = 0;
    for (let i = 0; i < 11; i++) {
        const sum = a[i] + b[i] + carry;
        const whole = Math.floor(sum / 16777216);
        o[i] = sum - whole * 16777216;
        carry = whole;
    }
    o[11] = carry;
    if (carry > 0 || fCmp(o, m) >= 0) {
        let borrow = 0;
        for (let i = 0; i < 11; i++) {
            const difference = o[i] - m[i] - borrow;
            if (difference < 0) {
                o[i] = difference + 16777216;
                borrow = 1;
            } else {
                o[i] = difference;
                borrow = 0;
            }
        }
        o[11] = 0;
    }
}

/** A difference, which is a subtraction of two values the caller knows are in order. */
function fSubRaw(o: Float64Array, a: Float64Array, b: Float64Array): void {
    let borrow = 0;
    for (let i = 0; i < 11; i++) {
        const difference = a[i] - b[i] - borrow;
        if (difference < 0) {
            o[i] = difference + 16777216;
            borrow = 1;
        } else {
            o[i] = difference;
            borrow = 0;
        }
    }
    o[11] = 0;
}

/**
 * A difference below the prime.
 *
 * A subtraction that came out negative is taken back by adding the prime to what
 * is left of it, and that add carries into the twelfth limb exactly as often as
 * the addition above does.
 *
 * The prime less b is written into `w` rather than into the answer, because the
 * answer is then added to `a` and `a` is still to be read: a caller that wrote
 * the difference into the value it was subtracting from would have added a
 * value to itself.
 */
function fSubMod(o: Float64Array, a: Float64Array, b: Float64Array, m: Float64Array, w: Float64Array): void {
    if (fCmp(a, b) >= 0) {
        fSubRaw(o, a, b);
    } else {
        fSubRaw(w, m, b);
        fAddMod(o, a, w, m);
    }
}

/**
 * A product below the prime, by double and add over the bits of the
 * multiplicand.
 *
 * A 256 bit product does not fit in 256 bits, so it is never formed: the
 * running value is added into the answer on the turns where a bit of the
 * multiplicand is set, and doubled on every turn. Both stay below the prime, so
 * neither is a value wider than the buffer that holds it.
 *
 * Both sides are copied into `w` and `w2` before anything is written, which is
 * what lets a caller square a value in place: the answer is written into `o`
 * while the multiplicand is still being read, so a value that is both one of
 * them and the answer has to be held somewhere the loop is not writing.
 */
function fMulMod(o: Float64Array, a: Float64Array, b: Float64Array, m: Float64Array, w: Float64Array, w2: Float64Array, powers: Float64Array): void {
    fCopy(w, a);
    fCopy(w2, b);
    fZero(o);
    for (let limb = 0; limb < 11; limb++) {
        for (let shift = 0; shift < 24; shift++) {
            const chunk = Math.floor(w2[limb] / powers[shift]);
            if (chunk - Math.floor(chunk / 2) * 2 === 1) {
                fAddMod(o, o, w, m);
            }
            fAddMod(w, w, w, m);
        }
    }
}

/**
 * A value to a power, by square and multiply over the bits of the exponent.
 *
 * The exponent is a field value rather than a number because the one this
 * benchmark needs is the prime less two, which is 256 bits of it. `w` carries
 * the running value and `w2` is the working value of the product below, which
 * the answer cannot be while it is still being written.
 */
function fPowMod(o: Float64Array, a: Float64Array, e: Float64Array, m: Float64Array, w: Float64Array, w2: Float64Array, w3: Float64Array, powers: Float64Array): void {
    // The bits are read from the bottom up, so this is multiply and square: the
    // answer starts at one, the running value starts at the base, a set bit
    // multiplies the answer by it, and every turn squares it so that the next
    // bit's turn carries the next power of the base.
    fZero(o);
    o[0] = 1;
    fCopy(w, a);
    for (let limb = 0; limb < 11; limb++) {
        for (let shift = 0; shift < 24; shift++) {
            const chunk = Math.floor(e[limb] / powers[shift]);
            if (chunk - Math.floor(chunk / 2) * 2 === 1) {
                fMulMod(o, o, w, m, w2, w3, powers);
            }
            fMulMod(w, w, w, m, w2, w3, powers);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Points: three buffers passed beside each other, x, y and z.                  */
/* -------------------------------------------------------------------------- */

/**
 * Twice a point, by the fast doubling formula for a curve whose a is zero.
 *
 * From http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html, the
 * doubling dbl-2009-l, which costs 2M + 5S against the general formula's
 * 4M + 4S. The nine values it works in besides the point are the six the
 * formula names and the three coordinates it answers, and they are written
 * down in the order the formula computes them so that each is dead before the
 * next takes its place.
 */
function pDouble(x: Float64Array, y: Float64Array, z: Float64Array, m: Float64Array, a: Float64Array, b: Float64Array, c: Float64Array, d: Float64Array, e: Float64Array, f: Float64Array, g: Float64Array, h: Float64Array, i: Float64Array, w: Float64Array, w2: Float64Array, powers: Float64Array): void {
    fMulMod(a, x, x, m, w, w2, powers);
    fMulMod(b, y, y, m, w, w2, powers);
    fMulMod(c, b, b, m, w, w2, powers);
    fAddMod(d, x, b, m);
    fMulMod(d, d, d, m, w, w2, powers);
    fSubMod(d, d, a, m, w);
    fSubMod(d, d, c, m, w);
    fAddMod(d, d, d, m);
    fAddMod(e, a, a, m);
    fAddMod(e, e, a, m);
    fMulMod(f, e, e, m, w, w2, powers);
    // X3 is F - 2D, and Y3 is E * (D - X3) - 8C, so D is needed both doubled
    // and not: the doubled copy goes where A is, which is dead by now, and the
    // original stays where it is for the difference the second one needs.
    fAddMod(a, d, d, m);
    fSubMod(g, f, a, m, w);
    fSubMod(h, d, g, m, w);
    fMulMod(h, e, h, m, w, w2, powers);
    fAddMod(c, c, c, m);
    fAddMod(c, c, c, m);
    fAddMod(c, c, c, m);
    fSubMod(h, h, c, m, w);
    fMulMod(i, y, z, m, w, w2, powers);
    fAddMod(i, i, i, m);

    fCopy(x, g);
    fCopy(y, h);
    fCopy(z, i);
}

/**
 * The point at infinity, which is where double-and-add starts: doubling it
 * leaves it where it is, and adding the base to it is the base itself.
 *
 * It is all zeros, and the zero z is what says so: a Jacobian point is a pair
 * of coordinates and a scale, and a scale of zero is the point at infinity
 * whatever the two coordinates hold.
 */
function pInfinity(x: Float64Array, y: Float64Array, z: Float64Array): void {
    fZero(x);
    fZero(y);
    fZero(z);
}

/**
 * A point plus another, by the addition formula for a curve whose a is zero.
 *
 * From http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html, the
 * addition add-1998-cmo-2, which costs 12M + 4S.
 *
 * The answer is written over the point on the left, which is the point
 * double-and-add accumulates in, and the right point is copied in first because
 * it is read all the way through: without the copy, the second write to the
 * answer would take the point the addition is still reading.
 */
function pAdd(ax: Float64Array, ay: Float64Array, az: Float64Array, bx: Float64Array, by: Float64Array, bz: Float64Array, m: Float64Array, t1: Float64Array, t2: Float64Array, t3: Float64Array, t4: Float64Array, t5: Float64Array, t6: Float64Array, t7: Float64Array, t8: Float64Array, t9: Float64Array, t10: Float64Array, t11: Float64Array, t12: Float64Array, t13: Float64Array, t14: Float64Array, t15: Float64Array, w: Float64Array, w2: Float64Array, powers: Float64Array): void {
    fCopy(t1, bx);
    fCopy(t2, by);
    fCopy(t3, bz);
    // The point at infinity is (0 : 0 : 0), and the formula below is not what
    // says what adding one to a point is: it divides by a z that is zero there.
    // Infinity plus a point is the point, and a point plus infinity is itself,
    // which is the whole of what double-and-add needs, because the accumulator
    // starts at infinity and the base is never infinity.
    //
    // The third case the formula has - H zero, the two points being one point -
    // cannot arise here: the accumulator is a multiple of the base and the base
    // is not, so the two are equal only at the first bit set, which is the turn
    // infinity was on.
    if (fIsZero(az)) {
        fCopy(ax, t1);
        fCopy(ay, t2);
        fCopy(az, t3);
    } else if (!fIsZero(t3)) {
    fMulMod(t4, az, az, m, w, w2, powers);
    fMulMod(t5, t3, t3, m, w, w2, powers);
    fMulMod(t6, ax, t5, m, w, w2, powers);
    fMulMod(t7, t1, t4, m, w, w2, powers);
    fMulMod(t8, ay, t3, m, w, w2, powers);
    fMulMod(t8, t8, t5, m, w, w2, powers);
    fMulMod(t9, t2, az, m, w, w2, powers);
    fMulMod(t9, t9, t4, m, w, w2, powers);
    fSubMod(t10, t7, t6, m, w);
    fSubMod(t11, t9, t8, m, w);
    fAddMod(t11, t11, t11, m);
    // I is the square of twice H, so it is four times H squared, and J is H
    // times that. Taking I as twice H squared rather than four is the whole
    // difference between the point that comes out and a point on no curve.
    fMulMod(t12, t10, t10, m, w, w2, powers);
    fAddMod(ax, t12, t12, m);
    fAddMod(ax, ax, ax, m);
    fMulMod(t13, t10, ax, m, w, w2, powers);
    fMulMod(t14, t6, ax, m, w, w2, powers);
    fMulMod(t15, t11, t11, m, w, w2, powers);
    fSubMod(t15, t15, t13, m, w);
    fAddMod(ax, t14, t14, m);
    fSubMod(t15, t15, ax, m, w);
    // The three answers are written into buffers of their own and copied to the
    // coordinates at the end, each where the formula says it goes: writing them
    // where they are computed would leave the first of the three overwritten by
    // the second, which is a point on no curve as surely as the wrong factor in
    // I is. z is read once more, by the coordinate below it.
    fSubMod(ax, t14, t15, m, w);
    fMulMod(ax, t11, ax, m, w, w2, powers);
    fAddMod(ay, t8, t8, m);
    fMulMod(ay, ay, t13, m, w, w2, powers);
    fSubMod(t14, ax, ay, m, w);
    fMulMod(t9, az, t3, m, w, w2, powers);
    fMulMod(t9, t9, t10, m, w, w2, powers);
    fAddMod(t9, t9, t9, m);
    fCopy(ax, t15);
    fCopy(ay, t14);
    fCopy(az, t9);
    }
}

/**
 * A point multiplied by a scalar, by double and add over the bits of the
 * scalar from the top down.
 *
 * The accumulator is the point at infinity, and the addition writes its answer
 * over the accumulator, which is what double-and-add wants: the point on the
 * left of an addition is the one being accumulated in.
 */
function pMul(k: Float64Array, x: Float64Array, y: Float64Array, z: Float64Array, gx: Float64Array, gy: Float64Array, gz: Float64Array, m: Float64Array, t1: Float64Array, t2: Float64Array, t3: Float64Array, t4: Float64Array, t5: Float64Array, t6: Float64Array, t7: Float64Array, t8: Float64Array, t9: Float64Array, t10: Float64Array, t11: Float64Array, t12: Float64Array, t13: Float64Array, t14: Float64Array, t15: Float64Array, w: Float64Array, w2: Float64Array, powers: Float64Array): void {
    pInfinity(x, y, z);
    for (let limb = 10; limb >= 0; limb--) {
        for (let shift = 23; shift >= 0; shift--) {
            const chunk = Math.floor(k[limb] / powers[shift]);
            pDouble(x, y, z, m, t1, t2, t3, t4, t5, t6, t7, t8, t9, w, w2, powers);
            if (chunk - Math.floor(chunk / 2) * 2 === 1) {
                pAdd(x, y, z, gx, gy, gz, m, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13, t14, t15, w, w2, powers);
            }
        }
    }
}

/**
 * A point in affine coordinates: x / z^2 and y / z^3, with the inverse of z
 * from Fermat's little theorem, which is the prime less two as an exponent.
 */
function pAffine(x: Float64Array, y: Float64Array, z: Float64Array, m: Float64Array, e: Float64Array, outX: Float64Array, outY: Float64Array, t1: Float64Array, t2: Float64Array, t3: Float64Array, t4: Float64Array, w: Float64Array, w2: Float64Array, w3: Float64Array, powers: Float64Array): void {
    fPowMod(t1, z, e, m, w, w2, w3, powers);
    fMulMod(t2, t1, t1, m, w, w2, powers);
    fMulMod(t3, t2, t1, m, w, w2, powers);
    fMulMod(outX, x, t2, m, w, w2, powers);
    fMulMod(outY, y, t3, m, w, w2, powers);
}

/** A field value as its eleven limbs, most significant first. */
function showField(v: Float64Array): void {
    for (let i = 10; i >= 0; i--) {
        console.log(v[i]);
    }
}

/* -------------------------------------------------------------------------- */
/* The program: every buffer the functions work in, and the loop it is run in. */
/* -------------------------------------------------------------------------- */

const P = new Float64Array(12);
const E = new Float64Array(12);
const K = new Float64Array(12);
const POW = new Float64Array(24);
const GX = new Float64Array(12);
const GY = new Float64Array(12);
const GZ = new Float64Array(12);
const AX = new Float64Array(12);
const AY = new Float64Array(12);
const AZ = new Float64Array(12);
const FX = new Float64Array(12);
const FY = new Float64Array(12);
const W = new Float64Array(12);
const W2 = new Float64Array(12);
const W3 = new Float64Array(12);
const T1 = new Float64Array(12);
const T2 = new Float64Array(12);
const T3 = new Float64Array(12);
const T4 = new Float64Array(12);
const T5 = new Float64Array(12);
const T6 = new Float64Array(12);
const T7 = new Float64Array(12);
const T8 = new Float64Array(12);
const T9 = new Float64Array(12);
const T10 = new Float64Array(12);
const T11 = new Float64Array(12);
const T12 = new Float64Array(12);
const T13 = new Float64Array(12);
const T14 = new Float64Array(12);
const T15 = new Float64Array(12);

setPowers(POW);
setPrime(P);
setPrimeMinusTwo(E);
setPrivateKey(K);
setGeneratorX(GX);
setGeneratorY(GY);
GZ[0] = 1;

const repeats: number = +Deno.args[0] || 1;
for (let round = 0; round < repeats; round++) {
    pMul(K, AX, AY, AZ, GX, GY, GZ, P, T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, W, W2, POW);
}
pAffine(AX, AY, AZ, P, E, FX, FY, T1, T2, T3, T4, W, W2, W3, POW);

console.log("x");
showField(FX);
console.log("y");
showField(FY);