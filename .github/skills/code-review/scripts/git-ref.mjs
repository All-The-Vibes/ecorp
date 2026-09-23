// A literal branch name, never an option, revision expression, or reflog query.
export const branchRef = (ref) => typeof ref === 'string' && ref !== '@' && ref !== 'HEAD' &&
  !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|^-|\.$/.test(ref) &&
  ref.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
