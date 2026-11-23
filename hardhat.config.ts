import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import type { HardhatUserConfig } from 'hardhat/types';

const config: HardhatUserConfig = {
  plugins: [hardhatEthers],
  solidity: '0.8.24',
  networks: {
    hskTestnet: {
      type: 'http',
      url: 'https://testnet.hsk.xyz',
      chainId: 133,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    hskMainnet: {
      type: 'http',
      url: 'https://mainnet.hsk.xyz',
      chainId: 177,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

export default config;
