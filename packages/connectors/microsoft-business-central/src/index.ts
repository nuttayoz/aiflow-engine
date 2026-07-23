import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { connectorCapabilityHash } from '@aiflow/connector-sdk';

export interface PurchaseInvoiceDraftInput extends Readonly<
  Record<string, unknown>
> {
  readonly currencyCode: string;
  readonly invoiceDate: string;
  readonly totalAmount: string;
  readonly vendorInvoiceNumber: string;
  readonly vendorNumber: string;
}

export interface BusinessCentralReceipt {
  readonly actionId: 'create-purchase-invoice-draft';
  readonly actionVersion: 1;
  readonly appliedAt: Date;
  readonly companyResourceId: string;
  readonly connectorId: 'microsoft-business-central';
  readonly externalResourceId: string;
  readonly externalResourceNumber: string;
  readonly externalResourceType: 'purchaseInvoiceDraft';
  readonly externalVersion: string;
}

export type DestinationWriteResult =
  | { readonly receipt: BusinessCentralReceipt; readonly status: 'APPLIED' }
  | {
      readonly code: 'DESTINATION_THROTTLED' | 'DESTINATION_UNAVAILABLE';
      readonly retryAfter: Date;
      readonly status: 'NOT_APPLIED';
    }
  | {
      readonly code: 'DESTINATION_VALIDATION_FAILED';
      readonly status: 'FAILED';
    };

export type DestinationLookupResult =
  | { readonly receipt: BusinessCentralReceipt; readonly status: 'APPLIED' }
  | { readonly status: 'NOT_APPLIED' }
  | { readonly status: 'UNKNOWN' };

export interface BusinessCentralDestinationPort {
  apply(input: {
    readonly companyResourceId: string;
    readonly effectKey: string;
    readonly payload: PurchaseInvoiceDraftInput;
    readonly payloadSha256: string;
  }): Promise<DestinationWriteResult>;
  lookup(input: {
    readonly companyResourceId: string;
    readonly effectKey: string;
    readonly payloadSha256: string;
  }): Promise<DestinationLookupResult>;
}

export type FakeDestinationBehavior =
  | 'APPLY'
  | 'THROTTLE'
  | 'TIMEOUT_AFTER_APPLY'
  | 'TIMEOUT_BEFORE_APPLY'
  | 'VALIDATION_FAILURE';

interface AppliedEffect {
  readonly companyResourceId: string;
  readonly payloadSha256: string;
  readonly receipt: BusinessCentralReceipt;
}

const inputKeys = [
  'currencyCode',
  'invoiceDate',
  'totalAmount',
  'vendorInvoiceNumber',
  'vendorNumber',
] as const;

export const isPurchaseInvoiceDraftInput = (
  value: unknown,
): value is PurchaseInvoiceDraftInput => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).every((key) => inputKeys.includes(key as never)) &&
    inputKeys.every(
      (key) =>
        typeof input[key] === 'string' &&
        input[key].length > 0 &&
        input[key].length <= 100,
    ) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(String(input.invoiceDate)) &&
    /^[A-Z]{3}$/u.test(String(input.currencyCode)) &&
    /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/u.test(String(input.totalAmount))
  );
};

export class FakeBusinessCentralDestination implements BusinessCentralDestinationPort {
  private readonly effects = new Map<string, AppliedEffect>();

  constructor(
    private behavior: FakeDestinationBehavior = 'APPLY',
    private readonly clock: () => Date = () => new Date(),
  ) {}

  setBehavior(behavior: FakeDestinationBehavior): void {
    this.behavior = behavior;
  }

  async apply(input: {
    readonly companyResourceId: string;
    readonly effectKey: string;
    readonly payload: PurchaseInvoiceDraftInput;
    readonly payloadSha256: string;
  }): Promise<DestinationWriteResult> {
    const existing = this.effects.get(input.effectKey);
    if (existing !== undefined) {
      if (
        existing.payloadSha256 !== input.payloadSha256 ||
        existing.companyResourceId !== input.companyResourceId
      ) {
        throw new Error('DESTINATION_EFFECT_CONFLICT');
      }
      return { receipt: existing.receipt, status: 'APPLIED' };
    }
    if (!isPurchaseInvoiceDraftInput(input.payload)) {
      return { code: 'DESTINATION_VALIDATION_FAILED', status: 'FAILED' };
    }
    if (this.behavior === 'THROTTLE') {
      return {
        code: 'DESTINATION_THROTTLED',
        retryAfter: new Date(this.clock().getTime() + 1_000),
        status: 'NOT_APPLIED',
      };
    }
    if (this.behavior === 'TIMEOUT_BEFORE_APPLY') {
      throw new Error('DESTINATION_WRITE_OUTCOME_UNKNOWN');
    }
    if (this.behavior === 'VALIDATION_FAILURE') {
      return { code: 'DESTINATION_VALIDATION_FAILED', status: 'FAILED' };
    }
    const receipt: BusinessCentralReceipt = {
      actionId: 'create-purchase-invoice-draft',
      actionVersion: 1,
      appliedAt: this.clock(),
      companyResourceId: input.companyResourceId,
      connectorId: 'microsoft-business-central',
      externalResourceId: `fake-${input.effectKey}`,
      externalResourceNumber: `PI-${(this.effects.size + 1).toString().padStart(4, '0')}`,
      externalResourceType: 'purchaseInvoiceDraft',
      externalVersion: '1',
    };
    this.effects.set(input.effectKey, {
      companyResourceId: input.companyResourceId,
      payloadSha256: input.payloadSha256,
      receipt,
    });
    if (this.behavior === 'TIMEOUT_AFTER_APPLY') {
      throw new Error('DESTINATION_WRITE_OUTCOME_UNKNOWN');
    }
    return { receipt, status: 'APPLIED' };
  }

  async lookup(input: {
    readonly companyResourceId: string;
    readonly effectKey: string;
    readonly payloadSha256: string;
  }): Promise<DestinationLookupResult> {
    const existing = this.effects.get(input.effectKey);
    if (existing === undefined) {
      return { status: 'NOT_APPLIED' };
    }
    if (
      existing.payloadSha256 !== input.payloadSha256 ||
      existing.companyResourceId !== input.companyResourceId
    ) {
      throw new Error('DESTINATION_EFFECT_CONFLICT');
    }
    return { receipt: existing.receipt, status: 'APPLIED' };
  }

  effectCount(): number {
    return this.effects.size;
  }
}

const descriptor = {
  actions: [
    {
      actionId: 'create-purchase-invoice-draft',
      capability: 'DESTINATION',
      connectionRequired: true,
      configurationSchema: {
        additionalProperties: false,
        properties: {
          companyId: { maxLength: 180, minLength: 1, type: 'string' },
        },
        required: ['companyId'],
        type: 'object',
      },
      configurationSchemaVersion: 1,
      displayName: 'Create purchase invoice draft',
      provisioningMode: 'VALIDATE_ONLY',
      version: 1,
    },
  ],
  connectorId: 'microsoft-business-central',
  displayName: 'Microsoft Dynamics 365 Business Central',
  version: 1,
} as const;

export const microsoftBusinessCentralConnector: ConnectorAdapter = {
  descriptor,
  validateActivation: async () => ({
    capabilityHash: connectorCapabilityHash(descriptor),
    status: 'READY',
  }),
};

export * from './processor';
