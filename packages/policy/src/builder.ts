import type { Policy } from '@harnesskit/core';
import {
  type ArgRegexOptions,
  type HostnameAllowlistOptions,
  type PiiScanOptions,
  type RequireApprovalOptions,
  type TokenBudget,
  allowTools,
  argRegex,
  denyTools,
  hostnameAllowlist,
  maxToolCalls,
  piiScan,
  requireApproval,
  tokenBudget,
} from './builtins.js';
import { allOf } from './combinator.js';
import type { Pattern } from './match.js';

export class PolicyBuilder {
  private policies: Policy[] = [];

  allowTools(patterns: readonly Pattern[]): this {
    this.policies.push(allowTools(patterns));
    return this;
  }
  denyTools(patterns: readonly Pattern[]): this {
    this.policies.push(denyTools(patterns));
    return this;
  }
  requireApproval(opts: RequireApprovalOptions): this {
    this.policies.push(requireApproval(opts));
    return this;
  }
  tokenBudget(limits: TokenBudget): this {
    this.policies.push(tokenBudget(limits));
    return this;
  }
  maxToolCalls(limit: number): this {
    this.policies.push(maxToolCalls(limit));
    return this;
  }
  argRegex(opts: ArgRegexOptions): this {
    this.policies.push(argRegex(opts));
    return this;
  }
  hostnameAllowlist(opts: HostnameAllowlistOptions): this {
    this.policies.push(hostnameAllowlist(opts));
    return this;
  }
  piiScan(opts?: PiiScanOptions): this {
    this.policies.push(piiScan(opts ?? {}));
    return this;
  }
  add(p: Policy): this {
    this.policies.push(p);
    return this;
  }
  build(id = 'composed'): Policy {
    return allOf(this.policies, id);
  }
}

export const policy = (): PolicyBuilder => new PolicyBuilder();
