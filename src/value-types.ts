export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export function isString<T>(value: T): value is T & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

export function isNumber<T>(value: T): value is T & number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

export function isBoolean<T>(value: T): value is T & boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

export function isBigInt<T>(value: T): value is T & bigint {
  return Object.prototype.toString.call(value) === "[object BigInt]";
}

export function isFunction<T>(value: T): value is T & ((...args: never[]) => void) {
  return Object.prototype.toString.call(value) === "[object Function]";
}

export function isSymbol<T>(value: T): value is T & symbol {
  return Object.prototype.toString.call(value) === "[object Symbol]";
}

export function isObject<T>(value: T): value is T & object {
  return Object.prototype.toString.call(value) === "[object Object]";
}
