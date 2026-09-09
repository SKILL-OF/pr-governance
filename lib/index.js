// @pfm/pr-governance — programmatic entry points (reserved for future API surface)
// Direct usage: require('@pfm/pr-governance/lib/verify-pr') or gate-pr-merge
module.exports = {
  verifyPr: require.resolve('./verify-pr.js'),
  gatePrMerge: require.resolve('./gate-pr-merge.js'),
};
