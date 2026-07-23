import type { ConnectorAdapter } from '@aiflow/connector-sdk';
import { ConnectorRegistry } from '@aiflow/connector-sdk';
import { InMemoryExtractionProfileCatalog } from '@aiflow/extraction';

import { WorkflowDefinitionValidator } from './validator';

const connector = (
  connectorId: string,
  capability: 'DESTINATION' | 'ENTRY',
  actionId: string,
): ConnectorAdapter => ({
  descriptor: {
    actions: [
      {
        actionId,
        capability,
        configurationSchema: {
          additionalProperties: false,
          properties: {},
          type: 'object',
        },
        configurationSchemaVersion: 1,
        displayName: actionId,
        provisioningMode: 'NONE',
        version: 1,
      },
    ],
    connectorId,
    displayName: connectorId,
    version: 1,
  },
  validateActivation: async () => ({
    capabilityHash: 'hash',
    status: 'READY',
  }),
});

const validator = new WorkflowDefinitionValidator(
  new ConnectorRegistry([
    connector('direct-upload', 'ENTRY', 'receive'),
    connector('test-destination', 'DESTINATION', 'deliver'),
  ]),
  new InMemoryExtractionProfileCatalog([
    {
      displayName: 'Invoice',
      outputFields: ['invoice_number'],
      outputSchemaHash: 'schema-hash',
      profileId: 'invoice',
      profileKind: 'SYSTEM',
      profileVersionId: 'invoice-v1',
    },
  ]),
);

const definition = {
  destination: {
    actionId: 'deliver',
    config: {},
    connectorId: 'test-destination',
  },
  entry: { config: {}, connectorId: 'direct-upload' },
  extraction: { config: {}, profileId: 'invoice' },
  mappings: [
    {
      required: true,
      sourceField: 'invoice_number',
      targetField: 'documentNumber',
    },
  ],
  reviewPolicy: { required: false },
  schemaVersion: 1,
};

describe('WorkflowDefinitionValidator', () => {
  it('validates and freezes a provider-neutral definition', () => {
    const result = validator.validate(definition);

    expect(result).toMatchObject({
      valid: true,
      value: {
        definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        profileReference: { profileVersionId: 'invoice-v1' },
      },
    });
  });

  it('rejects unknown extraction fields and legacy-shaped input', () => {
    expect(
      validator.validate({
        ...definition,
        mappings: [{ sourceField: 'unknown', targetField: 'documentNumber' }],
      }),
    ).toMatchObject({
      issues: [
        {
          code: 'SOURCE_FIELD_UNKNOWN',
          path: '/mappings/0/sourceField',
        },
      ],
      valid: false,
    });
    expect(validator.validate({ payload_version: 2 })).toMatchObject({
      valid: false,
    });
  });
});
