export type ConnectorCapability = 'DESTINATION' | 'ENTRY';
export type ConnectorProvisioningMode = 'MANAGED' | 'NONE' | 'VALIDATE_ONLY';

export type ConnectorJsonSchema = Readonly<Record<string, unknown>>;

export interface ConnectorActionDescriptor {
  readonly actionId: string;
  readonly capability: ConnectorCapability;
  readonly connectionRequired: boolean;
  readonly configurationSchema: ConnectorJsonSchema;
  readonly configurationSchemaVersion: number;
  readonly displayName: string;
  readonly provisioningMode: ConnectorProvisioningMode;
  readonly version: number;
}

export interface ConnectorDescriptor {
  readonly actions: readonly ConnectorActionDescriptor[];
  readonly connectionConfigurationSchema?: ConnectorJsonSchema;
  readonly connectionConfigurationSchemaVersion?: number;
  readonly connectorId: string;
  readonly displayName: string;
  readonly version: number;
}

export interface ConnectorActivationContext {
  readonly actionId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly connectionId?: string;
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ConnectorActivationResult {
  readonly capabilityHash: string;
  readonly status: 'READY';
}

export interface ConnectorAdapter {
  readonly descriptor: ConnectorDescriptor;
  validateActivation(
    context: ConnectorActivationContext,
  ): Promise<ConnectorActivationResult>;
}

export interface ConnectorValidationIssue {
  readonly code: string;
  readonly path: string;
}

export type ConnectorValidationResult =
  | { readonly valid: true }
  | {
      readonly issues: readonly ConnectorValidationIssue[];
      readonly valid: false;
    };
