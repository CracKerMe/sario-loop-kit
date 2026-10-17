/**
 * Browser-safe evaluator for the small condition language used by journey
 * previews. The authoritative runtime evaluator remains in the workflow
 * engine; this parser keeps the editor and dry-run bundle free of Node-only
 * engine modules.
 */

type Token =
  | { kind: "literal"; value: unknown }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "paren"; value: "(" | ")" }
  | { kind: "eof" };

const OPERATORS = ["===", "!==", "==", "!=", ">=", "<=", "&&", "||", ">", "<"];

export function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  const parser = new ExpressionParser(tokenize(expression), context);
  return Boolean(parser.parse());
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let value = "";
      index += 1;
      while (index < expression.length) {
        const current = expression[index]!;
        if (current === "\\") {
          const escaped = expression[index + 1];
          if (escaped === undefined) throw new Error("unterminated string literal");
          value += escaped;
          index += 2;
          continue;
        }
        if (current === quote) break;
        value += current;
        index += 1;
      }
      if (expression[index] !== quote) throw new Error("unterminated string literal");
      tokens.push({ kind: "literal", value });
      index += 1;
      continue;
    }

    const number = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
    if (number) {
      tokens.push({ kind: "literal", value: Number(number) });
      index += number.length;
      continue;
    }

    const operator = OPERATORS.find((candidate) => expression.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: "operator", value: operator });
      index += operator.length;
      continue;
    }

    if (char === "!") {
      tokens.push({ kind: "operator", value: "!" });
      index += 1;
      continue;
    }

    const identifier = expression
      .slice(index)
      .match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*/)?.[0];
    if (identifier) {
      if (identifier === "true") tokens.push({ kind: "literal", value: true });
      else if (identifier === "false") tokens.push({ kind: "literal", value: false });
      else if (identifier === "null") tokens.push({ kind: "literal", value: null });
      else tokens.push({ kind: "identifier", value: identifier });
      index += identifier.length;
      continue;
    }

    throw new Error(`unexpected token near '${expression.slice(index)}'`);
  }

  tokens.push({ kind: "eof" });
  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: Record<string, unknown>,
  ) {}

  parse(): unknown {
    const result = this.parseOr();
    if (this.peek().kind !== "eof") throw new Error("unexpected trailing expression");
    return result;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOperator("||")) left = Boolean(left) || Boolean(this.parseAnd());
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseComparison();
    while (this.matchOperator("&&")) left = Boolean(left) && Boolean(this.parseComparison());
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseUnary();
    const operator = this.peek();
    if (
      operator.kind !== "operator" ||
      !["===", "!==", "==", "!=", ">=", "<=", ">", "<"].includes(operator.value)
    ) {
      return left;
    }
    this.index += 1;
    const right = this.parseUnary();
    switch (operator.value) {
      case "===":
      case "==":
        return left === right;
      case "!==":
      case "!=":
        return left !== right;
      case ">":
        return (left as number | string) > (right as number | string);
      case "<":
        return (left as number | string) < (right as number | string);
      case ">=":
        return (left as number | string) >= (right as number | string);
      case "<=":
        return (left as number | string) <= (right as number | string);
      default:
        return false;
    }
  }

  private parseUnary(): unknown {
    if (this.matchOperator("!")) return !this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.peek();
    if (token.kind === "literal") {
      this.index += 1;
      return token.value;
    }
    if (token.kind === "identifier") {
      this.index += 1;
      return getNestedValue(this.context, token.value);
    }
    if (token.kind === "paren" && token.value === "(") {
      this.index += 1;
      const value = this.parseOr();
      const closing = this.peek();
      if (closing.kind !== "paren" || closing.value !== ")") {
        throw new Error("missing closing parenthesis");
      }
      this.index += 1;
      return value;
    }
    throw new Error("expected a value");
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof" };
  }

  private matchOperator(value: string): boolean {
    const token = this.peek();
    if (token.kind !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

function getNestedValue(context: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
