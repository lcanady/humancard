# humancard contracts

Solidity contracts powering the on-chain identity layer for humancard.

## Stack

- Foundry (forge + cast)
- Solc 0.8.29, via-IR + optimizer
- EAS (Ethereum Attestation Service) on Base Sepolia / Base mainnet
- OpenZeppelin contracts

## Layout

```
contracts/
  src/        Solidity sources
  test/       Foundry tests
  script/     Deploy / config scripts
  lib/        forge install dependencies (gitignored if vendored elsewhere)
```

## Build + test

`lib/` is gitignored; first-time setup pulls dependencies via `forge install`.

```bash
cd contracts
forge install --no-git foundry-rs/forge-std
forge install --no-git ethereum-attestation-service/eas-contracts
forge install --no-git OpenZeppelin/openzeppelin-contracts
forge build
forge test -vvv
```

## Deployment

Base Sepolia is the v1 target. The deploy script reads EAS +
SchemaRegistry addresses from environment variables so the same script
runs against any EVM chain. See https://docs.attest.sh for the canonical
deployment per chain.
