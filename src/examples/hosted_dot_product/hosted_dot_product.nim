## hosted_dot_product: the same function, built against a host runtime.
##
## The Nim below is the input. The frontend turns it into a function contract,
## the model writes an implementation, and the compiler assembles it and links
## it into a Nim host program that provides the blaze runtime ABI. The
## candidate in candidates.json is a recorded answer, so this example builds
## offline:
##
##   cd src/examples/hosted_dot_product
##   blaze build --model replay:candidates.json
##
## The recorded candidate allocates its working copy through the runtime instead
## of on the stack, which is what a hosted build is for: the host owns memory
## management, and the generated code only asks for it through the ABI.

proc dotProduct(a: ptr float32, b: ptr float32, n: usize): float32 =
  var total: float32 = 0.0
  for i in 0 ..< n:
    total += a[i] * b[i]
  result = total
