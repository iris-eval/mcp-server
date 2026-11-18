// A deployment's own policy, as eval.plugins loads one: the answer must not promise a refund the ask did not mention.
// Written in an afternoon: it reads the ask without checking that one was sent, so on a call with no ask it throws.
// tests/fixtures/readback/make-rows-stored-by-main.mts loads it to make a row in which a gate that is not critical
// could not answer.
export default {
  name: 'no_refund_promise',
  kind: 'policy',
  mechanism: 'pattern',
  version: 1,
  needs: ['output', 'input'],
  description: 'The answer must not promise a refund the ask did not mention.',
  evaluate(ctx) {
    const promised = ctx.output.toLowerCase().includes('refund') && !ctx.input.toLowerCase().includes('refund');
    return { ruleName: 'no_refund_promise', passed: !promised, score: promised ? 0 : 1, message: promised ? 'The answer promises a refund the ask did not mention' : 'No refund promised' };
  },
};
