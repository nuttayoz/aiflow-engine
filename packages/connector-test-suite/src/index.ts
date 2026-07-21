import type {
  ConnectorActionDescriptor,
  ConnectorAdapter,
} from '@aiflow/connector-sdk';
import { ConnectorRegistry } from '@aiflow/connector-sdk';

export interface ConnectorContractIssue {
  readonly code: string;
  readonly path: string;
}

const checkAction = (
  action: ConnectorActionDescriptor,
): readonly ConnectorContractIssue[] => {
  const issues: ConnectorContractIssue[] = [];
  const schema = action.configurationSchema;

  if (schema.type !== 'object') {
    issues.push({ code: 'SCHEMA_MUST_BE_OBJECT', path: action.actionId });
  }
  if (schema.additionalProperties !== false) {
    issues.push({
      code: 'SCHEMA_MUST_REJECT_UNKNOWN_FIELDS',
      path: action.actionId,
    });
  }
  if (action.provisioningMode === 'MANAGED' && action.capability !== 'ENTRY') {
    issues.push({
      code: 'MANAGED_DESTINATION_REQUIRES_SEPARATE_CONTRACT',
      path: action.actionId,
    });
  }

  return issues;
};

export const runConnectorContractChecks = (
  adapter: ConnectorAdapter,
): readonly ConnectorContractIssue[] => {
  try {
    new ConnectorRegistry([adapter]);
  } catch (error: unknown) {
    return [
      {
        code: error instanceof Error ? error.message : 'DESCRIPTOR_INVALID',
        path: 'descriptor',
      },
    ];
  }

  return adapter.descriptor.actions.flatMap(checkAction);
};
