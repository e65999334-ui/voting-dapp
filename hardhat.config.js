require('@nomicfoundation/hardhat-toolbox');

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: {
        enabled: false,
        runs: 200
      }
    }
  },

  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    }
  },

  paths: {
    sources: './contracts',
    tests: './test',
    cache: './build/hardhat-cache',
    artifacts: './build/hardhat-artifacts'
  },

  mocha: {
    timeout: 120000
  }
};