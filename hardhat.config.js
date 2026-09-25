require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1
      },
      viaIR: false
    }
  },

  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    },

    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : []
    }
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./build/hardhat-cache",
    artifacts: "./build/hardhat-artifacts"
  },

  mocha: {
    timeout: 120000
  }
};