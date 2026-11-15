import { useVault, vaultName } from '../local/vault';

/** Who the journal belongs to, for display: works offline and without an account. */
export function useIdentity() {
  const vault = useVault();
  const name = vaultName(vault);
  return { name, displayName: name || 'Your journal', isAdmin: !!vault?.account?.isAdmin, synced: !!vault?.account, vault };
}
