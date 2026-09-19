// Published AI configuration is the shared contract for Settings and business APIs.
export function applyAiAgentContract(paths, core) {
  const s = { type: 'string' };
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const text = { type: 'string', minLength: 1, maxLength: 40000 };
  const rev = { type: 'integer', minimum: 0 };
  const version = { type: 'integer', minimum: 1 };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const envelope = (data) => object({ success: { type: 'boolean', const: true }, data });
  const json = { type: 'object', additionalProperties: true };
  const config = object({ modelId: { type: ['string', 'null'], minLength: 1 }, temperature: { type: 'number', minimum: 0, maximum: 2 }, maxTokens: { type: 'integer', minimum: 1, maximum: 16384 } }, []);
  const prompts = { type: 'array', minItems: 1, maxItems: 20, items: object({ role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string', minLength: 1, maxLength: 20000 } }) };
  const metadata = object({ agentId: id, promptVersion: version, model: s });
  const result = object({ output: s, model: s, latency: rev, promptVersion: version, agentId: id });
  Object.assign(core.schemas.Agent.properties, {
    builtinKey: { type: ['string', 'null'] }, draftRevision: rev, publishedVersion: { type: ['integer', 'null'], minimum: 1 },
    config: { type: 'object', additionalProperties: true, description: 'Draft config; legacy custom agents may contain older fields.' },
    prompts: { type: 'array', items: json, description: 'Draft prompts; legacy custom agents may be empty or need correction before publishing.' },
    workflow: { type: ['object', 'null'], properties: {
      label: s, description: s, variables: { type: 'array', items: s }, inputExample: json,
    }, required: ['label', 'description', 'variables', 'inputExample'], additionalProperties: false },
  });
  core.schemas.Agent.required = [...new Set([...core.schemas.Agent.required, 'builtinKey', 'draftRevision', 'publishedVersion', 'workflow'])];
  const agentFields = { name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 }, description: { type: ['string', 'null'] }, isActive: { type: 'boolean' }, config, prompts };
  core.schemas.AgentCreateRequest = object(agentFields, ['name', 'type', 'prompts']);
  core.schemas.AgentUpdateRequest = object({ ...agentFields, expectedRevision: rev, builtinKey: { type: ['string', 'null'] } }, ['expectedRevision']);
  core.schemas.AgentRunRequest = object({ task: { type: 'string', maxLength: 100 }, input: json }, ['input']);
  core.requestBodies.AgentUpdate.required = true;
  core.requestBodies.AgentRun.required = true;
  core.schemas.AgentRunResult = object({ ...result.properties, duration: s, status: { type: 'string', const: 'SUCCESS' } });
  core.schemas.AgentTestEnvelope = envelope(result);
  core.schemas.AgentVersionListEnvelope = envelope({ type: 'array', items: object({ version, config, prompts,
    createdBy: { type: ['string', 'null'] }, createdAt: { type: 'string', format: 'date-time' },
  }) });
  const configure = (path, method, schema, request) => {
    const op = paths[path][method];
    op['x-aerolink-contract-status'] = 'contracted';
    delete op['x-aerolink-deferred-reason'];
    op.description = 'Server-authoritative published AI configuration. Management requires agent.manage; test additionally requires agent.run. Publishing creates an immutable version; restore only changes the draft. Business execution never uses an unpublished draft.';
    op.responses['200'] = { description: 'AI configuration response', content: { 'application/json': { schema: ref(schema) } } };
    if (request) op.requestBody = { required: true, content: { 'application/json': { schema: request } } };
  };
  configure('/api/agents/{id}/versions', 'get', 'AgentVersionListEnvelope');
  configure('/api/agents/{id}/publish', 'post', 'AgentEnvelope', object({ expectedRevision: rev }));
  configure('/api/agents/{id}/toggle', 'post', 'AgentEnvelope', object({ expectedRevision: rev }));
  configure('/api/agents/{id}/restore', 'post', 'AgentEnvelope', object({ version, expectedRevision: rev }));
  configure('/api/agents/{id}/test', 'post', 'AgentTestEnvelope', object({ input: json }));
  // Credentials are write-only even when legacy records contain plain text.
  delete core.schemas.AiModel.properties.apiKey;
  core.schemas.AiModel.required = core.schemas.AiModel.required.filter((key) => key !== 'apiKey');
  core.schemas.AiModel.properties.hasApiKey = { type: 'boolean' };
  core.schemas.AiModel.required.push('hasApiKey');
  for (const schema of ['AiModelCreateRequest', 'AiModelUpdateRequest']) {
    core.schemas[schema].properties.provider.enum = ['openai', 'deepseek', 'ollama', 'custom'];
    core.schemas[schema].properties.apiKey = { type: ['string', 'null'], writeOnly: true, maxLength: 8192 };
    core.schemas[schema].properties.baseUrl = { type: ['string', 'null'], description: 'HTTPS endpoint without credentials, query or fragment; local HTTP allowed. Custom and Ollama require an explicit URL.' };
  }
  core.schemas.AiParseEmailRequest = { oneOf: [object({ emailId: id }), object({ subject: text, body: text })] };
  core.schemas.AiAnalyzeQuotesRequest = { oneOf: [object({ rfqId: id }), object({ rfqDetails: text, supplierQuotes: text })] };
  core.schemas.AiGenerateEmailRequest = { oneOf: [object({ quotationId: id }), object({
    customerName: text, partNumber: text, quantity: { type: 'number', exclusiveMinimum: 0 },
    unitPrice: { type: 'number', minimum: 0 }, totalPrice: { type: 'number', minimum: 0 },
    incoterm: { type: 'string', maxLength: 100 }, incotermLocation: { type: 'string', maxLength: 200 },
    leadTimeDays: { type: 'number', minimum: 0 }, validityDays: { type: 'number', exclusiveMinimum: 0 },
  }, ['customerName', 'partNumber', 'quantity', 'unitPrice', 'totalPrice', 'validityDays'])] };
  core.schemas.AiChatRequest = object({ message: text });
  for (const name of ['AiParsedEmail', 'AiQuoteAnalysis', 'AiGeneratedEmail', 'AiCompletion']) {
    core.schemas[name].properties.ai = metadata;
    core.schemas[name].required = [...new Set([...core.schemas[name].required, 'ai'])];
  }
  core.schemas.AiParsedEmail.properties.requiredDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  core.schemas.AiParsedEmail.properties.quantities.items.minimum = 1;
  for (const path of ['/api/ai/parse-email', '/api/ai/analyze-quotes', '/api/ai/generate-email', '/api/ai/chat']) {
    paths[path].post.description = 'Runs the matching built-in agent using its immutable published prompt and selected active model. Requires agent.run; email extraction additionally requires email.read, quote analysis requires rfq.read and supplier_quote.read, email generation requires quotation.read. Chat only uses supplied text. ID-based inputs enforce record access; output is advisory and does not create, approve, order or send. No automatic fallback to simulated output.';
  }
}
