import { createHash } from 'node:crypto';

import Ajv, { type JSONSchemaType } from 'ajv';

import type {
  ConnectorActionDescriptor,
  ConnectorRegistry,
} from '@aiflow/connector-sdk';
import type { ExtractionProfileCatalog } from '@aiflow/extraction';

import type {
  WorkflowDefinitionV1,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from './definition';

interface MutableWorkflowDefinition {
  destination: {
    actionId: string;
    config: Record<string, unknown>;
    connectionId?: string;
    connectorId: string;
  };
  entry: {
    config: Record<string, unknown>;
    connectionId?: string;
    connectorId: string;
  };
  extraction: { config: Record<string, unknown>; profileId: string };
  mappings: { required?: boolean; sourceField: string; targetField: string }[];
  reviewPolicy:
    { required: false } | { expiresAfterSeconds: number; required: true };
  schemaVersion: 1;
}

const identifier = { maxLength: 256, minLength: 1, type: 'string' } as const;
const configObject = {
  additionalProperties: true,
  required: [],
  type: 'object',
} as const;

const workflowSchema: JSONSchemaType<MutableWorkflowDefinition> = {
  additionalProperties: false,
  properties: {
    destination: {
      additionalProperties: false,
      properties: {
        actionId: identifier,
        config: configObject,
        connectionId: { ...identifier, nullable: true },
        connectorId: identifier,
      },
      required: ['connectorId', 'actionId', 'config'],
      type: 'object',
    },
    entry: {
      additionalProperties: false,
      properties: {
        config: configObject,
        connectionId: { ...identifier, nullable: true },
        connectorId: identifier,
      },
      required: ['connectorId', 'config'],
      type: 'object',
    },
    extraction: {
      additionalProperties: false,
      properties: { config: configObject, profileId: identifier },
      required: ['profileId', 'config'],
      type: 'object',
    },
    mappings: {
      items: {
        additionalProperties: false,
        properties: {
          required: { nullable: true, type: 'boolean' },
          sourceField: identifier,
          targetField: identifier,
        },
        required: ['sourceField', 'targetField'],
        type: 'object',
      },
      maxItems: 1000,
      type: 'array',
    },
    reviewPolicy: {
      oneOf: [
        {
          additionalProperties: false,
          properties: { required: { const: false, type: 'boolean' } },
          required: ['required'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            expiresAfterSeconds: {
              maximum: 2_592_000,
              minimum: 60,
              type: 'integer',
            },
            required: { const: true, type: 'boolean' },
          },
          required: ['required', 'expiresAfterSeconds'],
          type: 'object',
        },
      ],
      type: 'object',
    },
    schemaVersion: { const: 1, type: 'number' },
  },
  required: [
    'schemaVersion',
    'entry',
    'extraction',
    'mappings',
    'reviewPolicy',
    'destination',
  ],
  type: 'object',
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(workflowSchema);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const entryAction = (
  registry: ConnectorRegistry,
  connectorId: string,
): ConnectorActionDescriptor | undefined => {
  const actions = registry
    .get(connectorId)
    ?.descriptor.actions.filter((action) => action.capability === 'ENTRY');
  return actions?.length === 1 ? actions[0] : undefined;
};

export class WorkflowDefinitionValidator {
  constructor(
    private readonly connectors: ConnectorRegistry,
    private readonly extractionProfiles: ExtractionProfileCatalog,
  ) {}

  validate(input: unknown): WorkflowValidationResult {
    if (!validateSchema(input)) {
      return {
        issues: (validateSchema.errors ?? []).map((error) => ({
          code: error.keyword.toUpperCase(),
          path: error.instancePath || '/',
        })),
        valid: false,
      };
    }

    const definition = input as WorkflowDefinitionV1;
    const issues: WorkflowValidationIssue[] = [];
    const entry = entryAction(this.connectors, definition.entry.connectorId);
    if (entry === undefined) {
      issues.push({ code: 'NOT_INSTALLED', path: '/entry/connectorId' });
    } else {
      if (
        entry.connectionRequired &&
        definition.entry.connectionId === undefined
      ) {
        issues.push({
          code: 'CONNECTION_REQUIRED',
          path: '/entry/connectionId',
        });
      }
      if (
        !entry.connectionRequired &&
        definition.entry.connectionId !== undefined
      ) {
        issues.push({
          code: 'CONNECTION_NOT_ALLOWED',
          path: '/entry/connectionId',
        });
      }
      const result = this.connectors.validateConfiguration(
        definition.entry.connectorId,
        entry.actionId,
        definition.entry.config,
      );
      if (!result.valid) {
        issues.push(
          ...result.issues.map((issue) => ({
            code: issue.code,
            path: `/entry/config${issue.path === '/' ? '' : issue.path}`,
          })),
        );
      }
    }

    let destination: ConnectorActionDescriptor | undefined;
    try {
      destination = this.connectors.requireAction(
        definition.destination.connectorId,
        definition.destination.actionId,
      );
      if (destination.capability !== 'DESTINATION') {
        issues.push({
          code: 'CAPABILITY_INVALID',
          path: '/destination/actionId',
        });
      }
    } catch {
      issues.push({ code: 'NOT_INSTALLED', path: '/destination/actionId' });
    }
    if (destination !== undefined) {
      if (
        destination.connectionRequired &&
        definition.destination.connectionId === undefined
      ) {
        issues.push({
          code: 'CONNECTION_REQUIRED',
          path: '/destination/connectionId',
        });
      }
      if (
        !destination.connectionRequired &&
        definition.destination.connectionId !== undefined
      ) {
        issues.push({
          code: 'CONNECTION_NOT_ALLOWED',
          path: '/destination/connectionId',
        });
      }
      const result = this.connectors.validateConfiguration(
        definition.destination.connectorId,
        destination.actionId,
        definition.destination.config,
      );
      if (!result.valid) {
        issues.push(
          ...result.issues.map((issue) => ({
            code: issue.code,
            path: `/destination/config${issue.path === '/' ? '' : issue.path}`,
          })),
        );
      }
    }

    const profile = this.extractionProfiles.find(
      definition.extraction.profileId,
    );
    if (profile === undefined) {
      issues.push({ code: 'NOT_INSTALLED', path: '/extraction/profileId' });
    } else {
      const fields = new Set(profile.outputFields);
      definition.mappings.forEach((mapping, index) => {
        if (!fields.has(mapping.sourceField)) {
          issues.push({
            code: 'SOURCE_FIELD_UNKNOWN',
            path: `/mappings/${index}/sourceField`,
          });
        }
      });
    }

    if (issues.length > 0 || profile === undefined) {
      return { issues, valid: false };
    }

    const connectionReferences = [
      ...(definition.entry.connectionId === undefined
        ? []
        : [
            {
              connectionId: definition.entry.connectionId,
              purpose: 'ENTRY' as const,
            },
          ]),
      ...(definition.destination.connectionId === undefined
        ? []
        : [
            {
              connectionId: definition.destination.connectionId,
              purpose: 'DESTINATION' as const,
            },
          ]),
    ];

    return {
      valid: true,
      value: {
        connectionReferences,
        definition,
        definitionHash: createHash('sha256')
          .update(stableJson(definition))
          .digest('hex'),
        profileReference: {
          outputSchemaHash: profile.outputSchemaHash,
          profileId: profile.profileId,
          profileKind: profile.profileKind,
          profileVersionId: profile.profileVersionId,
        },
      },
    };
  }
}
