/**
 * Build-time defaults for a fork of VOID Workshop. scripts/fork-setup.sh writes this file from fork.json, so a
 * fork ships with its own update repository and relay already filled in. Users can still change both in
 * Settings → Updates; these are only the starting values.
 */
export const FORK_DEFAULTS: { updateRepo: string; relayUrl: string } = {
  updateRepo: '',
  relayUrl: '',
};
