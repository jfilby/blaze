## hosted_dot_product: the same function, built against a host runtime.
##
## The Nim below is the input. The frontend turns it into a function contract,
## the compiler resolves it into the semantic IR and assembles it into a Nim
## host program that provides the blaze runtime ABI. The review in
## reviews.json is a recorded answer to the review of that IR, so this example
## builds offline:
##
##   cd src/examples/hosted_dot_product
##   blaze build --model replay:reviews.json
##
## The review finds nothing to change, so what is built is the IR the compiler
## resolves for the Nim below. A hosted build is for a program that needs the
## heap: the host owns memory management, and the generated code asks for it
## through the ABI rather than managing memory itself.

proc dotProduct(a: ptr float32, b: ptr float32, n: usize): float32 =
  var total: float32 = 0.0
  for i in 0 ..< n:
    total += a[i] * b[i]
  result = total
