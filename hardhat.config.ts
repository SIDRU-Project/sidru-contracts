import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const AMOY_RPC_URL = process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology";
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL ?? "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Polygon Amoy testnet (gas token POL).
    amoy: {
      url: AMOY_RPC_URL,
      chainId: 80002,
      // Only attach the deployer account if the private key is present in .env.
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // Polygon mainnet (gas token POL). Real money: see docs/specs/sidru-mainnet/runbook-mainnet.md.
    polygon: {
      url: POLYGON_RPC_URL,
      chainId: 137,
      // Only attach the deployer account if the private key is present in .env.
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Etherscan V2 multichain: a single API key (string) covers Polygon / Amoy.
    // The v2 flow sends the chainid automatically based on the network's chainId.
    apiKey: ETHERSCAN_API_KEY,
    customChains: [
      {
        network: "amoy",
        chainId: 80002,
        urls: {
          // Etherscan V2 unified API endpoint, chain selected via chainid query param.
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
      {
        network: "polygon",
        chainId: 137,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://polygonscan.com",
        },
      },
    ],
  },
};

export default config;
