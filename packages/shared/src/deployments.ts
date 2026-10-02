import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Reader for `deployments/<chainId>.json`.
 *
 * Every consumer goes through here so that no address is ever written twice. A
 * keeper with its own copy of an address is a keeper that can be pointed at a
 * contract the rest of the system does not know about, and a web app with a
 * stale literal shows confident numbers from a dead deployment.
 */
export interface Deployment {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly deployer: string;
  readonly contracts: Readonly<Record<string, string>>;
  readonly txHashes?: Readonly<Record<string, string>>;
  readonly notes?: string;
}

export const CHAINS = {
  baseSepolia: 84_532,
  genlayerAsimov: 4_221,
  ethereumSepolia: 11_155_111,
} as const;

/** Repository root, resolved from this file rather than from `process.cwd()`. */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function deploymentPath(chainId: number, root = repoRoot()): string {
  return join(root, 'deployments', `${chainId}.json`);
}

export function hasDeployment(chainId: number, root = repoRoot()): boolean {
  return existsSync(deploymentPath(chainId, root));
}

export function loadDeployment(chainId: number, root = repoRoot()): Deployment {
  const path = deploymentPath(chainId, root);
  if (!existsSync(path)) {
    throw new Error(`no deployment manifest for chain ${chainId} at ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Deployment;
  if (parsed.chainId !== chainId) {
    throw new Error(`manifest ${path} declares chainId ${parsed.chainId}, expected ${chainId}`);
  }
  return parsed;
}

/**
 * Fetch one address, failing loudly when it is absent.
 *
 * The throw matters more than it looks: `undefined` flowing into a contract call
 * becomes the zero address in most clients, and a transaction sent to the zero
 * address succeeds silently rather than reverting.
 */
export function addressOf(d: Deployment, contract: string): string {
  const address = d.contracts[contract];
  if (!address) {
    throw new Error(
      `contract ${contract} missing from chain ${d.chainId} manifest ` +
        `(have: ${Object.keys(d.contracts).join(', ') || 'none'})`,
    );
  }
  return address;
}
