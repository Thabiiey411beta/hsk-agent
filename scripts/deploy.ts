// RiskVault deploy script (Hardhat).
//   npx hardhat run scripts/deploy.ts --network hskTestnet
//   npx hardhat run scripts/deploy.ts --network hskMainnet   <-- DO NOT RUN
//       without Newton's explicit approval + mainnet HSK for gas.
//       Mainnet is a DECISION POINT, not a default (see MAINNET-NOTE.md).
// Testnet deploy is allowed only with testnet HSK obtained legitimately (faucet).
// The script refuses to run on mainnet unless MAINNET_CONFIRMED=yes is set in
// the environment — a second explicit lock on top of Newton's approval.
import { network } from 'hardhat';

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Deployer: ${deployer.address}  chain: ${chainId}`);
  if (chainId === 177n && process.env.MAINNET_CONFIRMED !== 'yes') {
    throw new Error(
      'MAINNET DEPLOY BLOCKED: set MAINNET_CONFIRMED=yes only after Newton approves the mainnet deploy and funds the deployer. See MAINNET-NOTE.md.',
    );
  }
  const agent = process.env.AGENT_ADDRESS ?? deployer.address;
  const Vault = await ethers.getContractFactory('RiskVault');
  const vault = await Vault.deploy(
    agent,
    1000, // per-trade cap 10%
    3000, // daily cap 30%
    200, // stop-loss 2%
    1000, // max drawdown 10%
    500, // daily loss limit 5%
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`RiskVault v2 deployed at ${vaultAddress} (agent=${agent})`);
  // v3 (2026-11-23): point the vault at the fairly-priced tWHSK/tUSDT pool
  // (testnet only — mainnet deploy refuses above unless MAINNET_CONFIRMED=yes,
  // and this block runs only on chain 133). poolKind MUST match the pool:
  // kind 1 = tWHSK/tUSDT (token0 tWHSK 18 dec, token1 tUSDT 6 dec); kind 0 =
  // demo USDT/WHSK (18/18). A mismatched kind makes exitIfBreached compute a
  // nonsense price and the on-chain stop silently never fire.
  if (chainId === 133n) {
    const pool = process.env.VAULT_POOL ?? '0x840fa6e439F52cEa60dABec8BBB820DE80dDb542';
    const kind = Number(process.env.VAULT_POOL_KIND ?? 1);
    const tx = await vault.setPool(pool);
    await tx.wait();
    console.log(`RiskVault pool set to ${pool} (tx ${tx.hash})`);
    const tx2 = await vault.setPoolKind(kind);
    await tx2.wait();
    console.log(`RiskVault poolKind set to ${kind} (tx ${tx2.hash})`);
    console.log('NOTE: v1 vault 0x4D3fF0EE974b93C22103046715B20EC451c4f467 and v2 vault 0x9bF92125ba39c9a23D373aeFb408d7aF1C14A193 stay deployed; v3 supersedes them.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
