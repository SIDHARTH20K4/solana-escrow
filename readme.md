# Solana Escrow Workspace

This repository contains two Anchor programs, a vault and an escrow, along with their test suites. This document walks through what each program does, how the code is structured, and how the tests verify the behavior.

## Workspace layout

```
programs/
├── solana-escrow
│   ├── Cargo.toml
│   ├── src
│   │   ├── constants.rs
│   │   ├── error.rs
│   │   ├── instructions/
│   │   │   ├── make.rs
│   │   │   ├── refund.rs
│   │   │   ├── take.rs
│   │   │   └── update.rs
│   │   ├── instructions.rs
│   │   ├── lib.rs
│   │   └── state.rs
│   └── tests
└── vault
    ├── Cargo.toml
    ├── src
    │   ├── constants.rs
    │   ├── error.rs
    │   ├── instructions/
    │   │   ├── close.rs
    │   │   ├── deposit.rs
    │   │   └── withdraw.rs
    │   ├── instructions.rs
    │   ├── lib.rs
    │   └── state.rs
    └── tests
        └── vault_test.rs

tests/
├── vault.ts
└── escrow.ts
```

Both programs are built with Anchor and live under the same workspace, so they share a `Cargo.lock`, a `target` directory, and an `Anchor.toml` that wires up program IDs and test scripts.

## The vault program

The vault program is the simpler of the two. Its whole job is to let a wallet park some SOL under a program controlled account and pull it back out later.

### State

`state.rs` defines the `Vault` account:

```rust
#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
}
```

It stores the owner's public key and the bump used to derive the PDA. `Vault::LEN` accounts for the 8 byte Anchor discriminator plus the 32 bytes for the pubkey plus 1 byte for the bump.

### Constants

`constants.rs` holds a few program wide values: the counter seed, a lamport constant, and a max count value. These aren't all used by the vault logic itself but are declared as `#[constant]` so they show up in the generated IDL.

### Errors

`error.rs` defines two custom errors: `Unauthorized` and `InsufficientFunds`. The withdraw instruction uses `InsufficientFunds` when someone tries to pull out more than the vault holds.

### Instructions

**Deposit** (`instructions/deposit.rs`)

This creates the vault PDA the first time it's called, seeded by `["vault", owner_pubkey]`. The account is initialized with `init`, paid for by the owner, sized to `Vault::LEN`.

Inside the handler, the vault's `owner` and `bump` fields get set, and then the actual SOL transfer happens through a proper System Program CPI:

```rust
let cpi_accounts = Transfer {
    from: ctx.accounts.owner.to_account_info(),
    to: ctx.accounts.vault.to_account_info(),
};
let cpi_ctx = CpiContext::new(ctx.accounts.system_program.key(), cpi_accounts);
transfer(cpi_ctx, amount)?;
```

This matters because the vault program doesn't own the owner's wallet account. Directly mutating lamports on an account you don't own gets rejected by the runtime, which is exactly the bug we ran into early on. Routing the transfer through the System Program's CPI is the correct way to move lamports out of a signer's wallet.

**Withdraw** (`instructions/withdraw.rs`)

Here the vault does own the destination logic differently. Since the vault PDA is owned by this program, the handler is allowed to debit and credit lamports directly using `try_borrow_mut_lamports`, after checking there's enough balance:

```rust
require!(
    vault_info.lamports() >= amount,
    ErrorCode::InsufficientFunds
);

**vault_info.try_borrow_mut_lamports()? -= amount;
**owner_info.try_borrow_mut_lamports()? += amount;
```

This is safe here because the vault account is program owned, so this program has the authority to move its lamports around without going through a CPI.

**Close** (`instructions/close.rs`)

This uses Anchor's `close = owner` constraint, which hands back the vault's remaining lamports to the owner and marks the account as closed in one step. The handler function itself does nothing beyond that, since the account constraints do all the work.

### Vault tests, Rust and LiteSVM

The original test file at `programs/vault/tests/vault_test.rs` uses LiteSVM, which runs the program directly against an in memory BPF loader rather than spinning up a real validator. It builds raw instructions by hand, computing Anchor's instruction and account discriminators from scratch with sha256, since LiteSVM tests don't go through the generated Anchor client.

It covers five cases:

- depositing creates the vault and moves lamports out of the owner
- withdrawing sends lamports back and shrinks the vault balance
- withdrawing more than the vault holds fails
- closing returns all lamports and removes the account
- closing from an account that isn't the owner fails

Getting these tests running required matching the `anchor-lang` version pinned in `Cargo.toml` to the installed Anchor CLI version, since a mismatch between the two caused the generated `#[program]` macro code to break in ways that only showed up as a failed compile, not a clean error message.

### Vault tests, TypeScript

Alongside the Rust suite, `tests/vault.ts` covers the same four flows (deposit, withdraw, insufficient funds, close) but goes through the real Anchor TypeScript client and a locally spun up `solana-test-validator`, driven by `anchor test`.

A few things worth calling out from getting this working:

- Anchor's newer client resolves PDA accounts like `vault` and well known programs like `systemProgram` automatically, so passing them explicitly in `.accounts({...})` throws a type error. They just get left out.
- The `Anchor.toml` had `skip_local_validator = true` left over from an earlier setup, which told `anchor test` not to start its own validator. Since nothing was listening on the RPC port, every balance check failed with a fetch error. Removing that line let `anchor test` spin up its own validator automatically.
- `typescript` had somehow resolved to a nonexistent 7.x version in `package.json`, which broke `ts-mocha`'s internal compiler calls. Pinning it back to `5.6.3` fixed the compile step entirely.

## The escrow program

The escrow program is a classic two sided token swap. A maker deposits token A into a vault and states how much of token B they want back. Any taker holding enough token B can complete the trade in one atomic instruction. If nobody takes the offer, the maker can refund themselves at any time.

### State

`state.rs` defines the `Escrow` account:

```rust
#[derive(InitSpace)]
#[account]
pub struct Escrow {
    pub seed: u64,
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub receive: u64,
    pub bump: u8,
    pub expiration: i64,
}
```

The `seed` lets one maker open multiple escrows at once, since it's part of the PDA derivation. `mint_a` and `mint_b` record which tokens are involved, `receive` is how much of token B the maker wants, and `expiration` is a timestamp field for future expiry checks.

### Constants and errors

`constants.rs` just holds the `ESCROW_SEED` byte string used in every PDA derivation. `error.rs` defines `EscrowExpired` and `InvalidAmount`, the second of which is used by the update instruction to reject a zero receive amount.

### Instructions

**Make** (`instructions/make.rs`)

This is the instruction that opens an escrow. It initializes the `Escrow` account at a PDA seeded by `["escrow", maker, seed]`, and also initializes a vault token account, an associated token account owned by the escrow PDA itself for mint A.

The handler has two steps, `init_escrow` which fills in all the escrow's fields, and `deposit` which moves the maker's token A into the vault using `transfer_checked`, a CPI that also validates the mint and decimals match what's expected.

**Take** (`instructions/take.rs`)

This is where the swap actually happens, in two steps inside one instruction:

1. `deposit_to_maker` moves the taker's token B into the maker's associated token account for mint B, an account that gets created on the fly with `init_if_needed` if it doesn't exist yet.
2. `withdraw_and_close_vault` moves the escrowed token A out of the vault into the taker's associated token account for mint A, then closes the now empty vault account, sending its rent back to the maker.

Both of these transfers out of the vault need the escrow PDA to sign, since the vault's authority is the escrow account, not a real wallet. That's done with `CpiContext::new_with_signer` and the escrow's seeds.

**Refund** (`instructions/refund.rs`)

If no taker shows up, the maker can call this to get their tokens back. It transfers whatever is sitting in the vault back to the maker's own token A account, then closes the vault. The `close = maker` constraint on the escrow account itself also hands back the escrow's rent.

**Update** (`instructions/update.rs`)

Lets the maker change how much token B they're asking for, as long as the new amount is greater than zero. The account constraints check that the caller is actually the maker of this specific escrow before letting the update through.

### Escrow tests

`tests/escrow.ts` drives the whole program through the real Anchor TypeScript client and a local validator, using `@solana/spl-token` to create actual SPL mints and token accounts rather than mocking anything.

The setup in the `before` hook creates two mints, funds the maker with token A and the taker with token B, and airdrops SOL to the taker so they can pay for their own transactions and rent.

From there the suite walks through the full lifecycle:

- making an escrow, checking the escrow account's fields and that the vault actually received the deposited tokens
- updating the receive amount and confirming the change stuck
- confirming a zero amount update gets rejected
- a taker completing the swap, checking that both sides received the right tokens and that the vault and escrow accounts both got closed out
- opening a second escrow with a different seed and refunding it, checking the maker gets their tokens back and both accounts close

Each escrow in the tests uses its own seed, since the same maker can't open two escrows with the same seed at the same PDA address at the same time.

## Running the tests

Both test files run through the same Anchor script defined in `Anchor.toml`:

```bash
anchor build
anchor test
```

This compiles both programs, starts a local validator, and runs `tests/vault.ts` and `tests/escrow.ts` against it through `ts-mocha`.

The original Rust LiteSVM suite for the vault program can still be run on its own with:

```bash
cd programs/vault
cargo test
```

which is faster since it skips the validator entirely and runs the program in process.