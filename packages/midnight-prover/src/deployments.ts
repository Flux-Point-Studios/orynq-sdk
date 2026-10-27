/** Deployment locations are untrusted hints; verifyPosted authenticates their bytes. */
export const PROOF_DEPLOYMENTS = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet" as const,
    address: "f44d99b014af2c21c3bb4db4ba727470c006181a3ede24074db1541a2c319cc5",
    deployTxHash: "d6aa6a541a297128ad4560743f712c397a6027c677985500076839cef9aecdfb",
    deployBlockHint: Object.freeze({
      txHash: "d6aa6a541a297128ad4560743f712c397a6027c677985500076839cef9aecdfb",
      blockHeight: 3201845,
      blockHash: "8d88d873f85482cf2249d68809bb996fa3942e6cf42216c9630994ecec236779",
    }),
    codeHash: "bd518847ed1c6800d129bdac57a1d595a0912afd74406a07d7838ae1ab060361",
    initialStateSha256: "55041c6c05f64fb1cf3aa974aba8e27a83206506bc40a6d21c540d8d294f01b2",
  }),
  preprod: Object.freeze({
    network: "preprod" as const,
    address: "9020196694e9738b77d977985f35b05a64aae79346ec87400750b48e38f27de6",
    deployTxHash: "d133a44a4978458d7950641f680256e940a809c7b0736090f3ae6193ccd5dc25",
    deployBlockHint: Object.freeze({
      txHash: "d133a44a4978458d7950641f680256e940a809c7b0736090f3ae6193ccd5dc25",
      blockHeight: 3151664,
      blockHash: "301f43611c552bf57ec3cb286094800fd957c0184054bd44f0ae104b4c3290b2",
    }),
    codeHash: "bd518847ed1c6800d129bdac57a1d595a0912afd74406a07d7838ae1ab060361",
    initialStateSha256: "55041c6c05f64fb1cf3aa974aba8e27a83206506bc40a6d21c540d8d294f01b2",
  }),
});
