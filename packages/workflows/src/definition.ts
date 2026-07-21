export interface WorkflowEntryBinding {
  readonly config: Readonly<Record<string, unknown>>;
  readonly connectionId?: string;
  readonly connectorId: string;
}

export interface WorkflowExtractionBinding {
  readonly config: Readonly<Record<string, unknown>>;
  readonly profileId: string;
}

export interface WorkflowMappingRule {
  readonly required?: boolean;
  readonly sourceField: string;
  readonly targetField: string;
}

export type WorkflowReviewPolicy =
  | { readonly required: false }
  | { readonly expiresAfterSeconds: number; readonly required: true };

export interface WorkflowDestinationBinding {
  readonly actionId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly connectionId?: string;
  readonly connectorId: string;
}

export interface WorkflowDefinitionV1 {
  readonly destination: WorkflowDestinationBinding;
  readonly entry: WorkflowEntryBinding;
  readonly extraction: WorkflowExtractionBinding;
  readonly mappings: readonly WorkflowMappingRule[];
  readonly reviewPolicy: WorkflowReviewPolicy;
  readonly schemaVersion: 1;
}

export interface ValidatedWorkflowDefinition {
  readonly connectionReferences: readonly {
    readonly connectionId: string;
    readonly purpose: 'DESTINATION' | 'ENTRY';
  }[];
  readonly definition: WorkflowDefinitionV1;
  readonly definitionHash: string;
  readonly profileReference: {
    readonly outputSchemaHash: string;
    readonly profileId: string;
    readonly profileKind: 'CUSTOM' | 'SYSTEM';
    readonly profileVersionId: string;
  };
}

export interface WorkflowValidationIssue {
  readonly code: string;
  readonly path: string;
}

export type WorkflowValidationResult =
  | { readonly valid: true; readonly value: ValidatedWorkflowDefinition }
  | {
      readonly issues: readonly WorkflowValidationIssue[];
      readonly valid: false;
    };
