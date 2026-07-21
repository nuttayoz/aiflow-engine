import { createHash } from 'node:crypto';

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import type {
  ConnectorActionDescriptor,
  ConnectorAdapter,
  ConnectorDescriptor,
  ConnectorValidationResult,
} from './types';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FORBIDDEN_SCHEMA_KEY =
  /(?:authorization|credential|password|presigned|secret|token|url)/iu;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

export const connectorCapabilityHash = (
  descriptor: ConnectorDescriptor,
): string => createHash('sha256').update(stableJson(descriptor)).digest('hex');

const assertDescriptor = (descriptor: ConnectorDescriptor): void => {
  if (
    !ID_PATTERN.test(descriptor.connectorId) ||
    descriptor.displayName.trim().length === 0 ||
    descriptor.version < 1 ||
    !Number.isInteger(descriptor.version) ||
    descriptor.actions.length === 0
  ) {
    throw new Error('CONNECTOR_DESCRIPTOR_INVALID');
  }

  const actionIds = new Set<string>();
  for (const action of descriptor.actions) {
    if (
      !ID_PATTERN.test(action.actionId) ||
      action.displayName.trim().length === 0 ||
      !Number.isInteger(action.version) ||
      action.version < 1 ||
      !Number.isInteger(action.configurationSchemaVersion) ||
      action.configurationSchemaVersion < 1 ||
      actionIds.has(action.actionId)
    ) {
      throw new Error('CONNECTOR_ACTION_DESCRIPTOR_INVALID');
    }
    if (FORBIDDEN_SCHEMA_KEY.test(stableJson(action.configurationSchema))) {
      throw new Error('CONNECTOR_SCHEMA_FORBIDDEN_FIELD');
    }
    actionIds.add(action.actionId);
  }
};

interface RegisteredConnector {
  readonly adapter: ConnectorAdapter;
  readonly validators: ReadonlyMap<string, ValidateFunction>;
}

export class ConnectorRegistry {
  private readonly ajv: Ajv;
  private readonly connectors = new Map<string, RegisteredConnector>();

  constructor(adapters: readonly ConnectorAdapter[]) {
    this.ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(this.ajv);

    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  descriptors(): readonly ConnectorDescriptor[] {
    return [...this.connectors.values()]
      .map(({ adapter }) => adapter.descriptor)
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
  }

  get(connectorId: string): ConnectorAdapter | undefined {
    return this.connectors.get(connectorId)?.adapter;
  }

  requireAction(
    connectorId: string,
    actionId: string,
  ): ConnectorActionDescriptor {
    const action = this.get(connectorId)?.descriptor.actions.find(
      (candidate) => candidate.actionId === actionId,
    );

    if (action === undefined) {
      throw new Error('CONNECTOR_ACTION_NOT_INSTALLED');
    }

    return action;
  }

  validateConfiguration(
    connectorId: string,
    actionId: string,
    configuration: unknown,
  ): ConnectorValidationResult {
    const connector = this.connectors.get(connectorId);
    const validator = connector?.validators.get(actionId);

    if (validator === undefined) {
      return {
        issues: [{ code: 'NOT_INSTALLED', path: 'connectorId' }],
        valid: false,
      };
    }
    if (validator(configuration)) {
      return { valid: true };
    }

    return {
      issues: (validator.errors ?? []).map((error) => ({
        code: error.keyword.toUpperCase(),
        path: error.instancePath || '/',
      })),
      valid: false,
    };
  }

  private register(adapter: ConnectorAdapter): void {
    assertDescriptor(adapter.descriptor);

    if (this.connectors.has(adapter.descriptor.connectorId)) {
      throw new Error('CONNECTOR_DUPLICATE');
    }

    this.connectors.set(adapter.descriptor.connectorId, {
      adapter,
      validators: new Map(
        adapter.descriptor.actions.map((action) => [
          action.actionId,
          this.ajv.compile(action.configurationSchema),
        ]),
      ),
    });
  }
}
