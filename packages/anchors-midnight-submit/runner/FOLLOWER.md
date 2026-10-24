# Authenticated Midnight block reads

`verifyFollowerBlock({source, block, checkpoints, maxSetChanges?})` checks one
explicit block reference. It binds the full body to the header's extrinsics root,
verifies GRANDPA finality under the supplied trust anchors, then authenticates
parent runtime code, execution events and timestamp through storage proofs.
Only after exact bare Midnight sends are decoded and bound to their body indices
does it classify their execution outcomes. It never reads indexer status or time.
Any authenticated application outside that body-bound send list stops the read,
including wrapped or scheduled dispatch that this bare-send decoder cannot represent.

The public `verifyBlockEffects(node, {blockHash, header})` shares execution proofs
across a block. Its header must already be authenticated. Its `outcome(index,
txHash)` requires an independently verified body/index/hash binding: System
failure events contain no transaction hash. The block reader enforces that
precondition. The existing anchor verifier still accepts full success only.

`registryOperator({chain, ...})` accepts an explicit reconciliation `ChainView`;
omitting it retains the existing adapter. The supplied view must match the
operator's network. A standing adapter must hold on partial execution. Passing
partial success to the legacy journal would mark a non-deployment attempt failed;
returning null could instead reach its TTL-based absence path.

A single verified block establishes neither source freshness nor continuous
coverage. The durable follower must check hash-linked ancestry, persist each
complete block atomically, bind state to network/policy/checkpoints and retain
unresolved attempts. Absence retirement requires exhaustive authenticated bodies
from before the attempt's first possible broadcast through its TTL plus margin.
An adapter without that interval must return no absence head. Rolling fee union,
restore continuity, policy admission and standing execution are separate work.

Undecodable sends or ambiguous execution stop this reader. They must not be
silently converted into missing transactions or coverage. Production transport
must separately bound decoded responses, deadlines and catch-up work.

Validation includes recorded real mainnet data and read-only public RPC checks at
blocks 3113832 and 3113847, including all three and five Midnight sends respectively.
No wallet is loaded and no transaction is prepared or broadcast by this module.
