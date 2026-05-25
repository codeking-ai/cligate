export const desktopWindowSearchSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    match: { type: 'string', enum: ['contains', 'exact', 'regex'] }
  }
};

export default {
  desktopWindowSearchSchema
};
