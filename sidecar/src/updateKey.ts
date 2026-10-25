/**
 * Public half of the Ed25519 key that signs desktop releases (see scripts/update-key.sh). Updates are only
 * installed when their manifest verifies against this key; while it is null this build cannot update itself.
 * The private key never enters the repository: it stays passphrase-encrypted on the release machine.
 */
export const UPDATE_PUBLIC_KEY: string | null = null;
