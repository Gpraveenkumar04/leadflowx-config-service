
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    company: { type: 'string' },
    website: { type: 'string', format: 'uri' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' }
  },
  required: ['name', 'company', 'website', 'email', 'phone'],
  additionalProperties: true
};

const validate = ajv.compile(schema);

export function validateLead(lead) {
  const valid = validate(lead);
  return valid ? null : validate.errors;
}
