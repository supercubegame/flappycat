/* ===========================================================================
 * 本地存储调用的白名单扫描器。单独成文件是为了能给它写自证样本。
 * ===========================================================================
 *
 * 首轮它自己就错了：用 [^)]* 把整个参数列表抓下来，于是 setItem(key, value)
 * 拿到的是 "key, value"，与白名单对不上，一个完全合法的调用被当成违规报了出来。
 * 尺子错，不是产品错。修法是只取第一个参数。
 *
 * 两侧都要有样本：合法写法必须**被看到且不报**（否则扫描器只是在沉默），
 * 非法写法必须被报。只有后一半的话，一个什么都扫不到的扫描器也全绿。
 * ======================================================================== */

export function stripCommentsAndStrings(source){
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length){
    const c = source[i];
    const n = source[i + 1];
    if (quote){
      if (c === '\\'){ out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += ' ';
      i += 1;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`'){ quote = c; out += ' '; i += 1; continue; }
    if (c === '/' && n === '/'){
      while (i < source.length && source[i] !== '\n'){ out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*'){
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')){
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* 返回所有 localStorage 调用的**第一个参数**。剥掩之后字符串字面量变成空白，
 * 所以 getItem(STORAGE.best) 活下来，而 getItem('x') 变成 getItem(   )。 */
export function storageCalls(source){
  const stripped = stripCommentsAndStrings(source);
  return [...stripped.matchAll(/localStorage\.(getItem|setItem|removeItem)\s*\(([^)]*)\)/g)]
    .map(m => ({ method: m[1], firstArg: m[2].split(',')[0].trim() }));
}

export function unregisteredStorageCalls(source){
  return storageCalls(source)
    .filter(hit => !/^STORAGE\./.test(hit.firstArg) && !/^key$/.test(hit.firstArg));
}

export function storageKeyLiterals(source){
  return [...source.matchAll(/^\s{2}(\w+): '([^']+)',$/gm)]
    .map(m => m[2])
    .filter(v => v.startsWith('flappycat.'));
}

/* 自证样本。两侧都在：合法的必须看见且不报，非法的必须报。 */
export const FIXTURES = {
  legal: [
    'window.localStorage.getItem(STORAGE.best)',
    'window.localStorage.setItem(STORAGE.muted, muted ? \'1\' : \'0\')',
    'window.localStorage.removeItem(key)',
  ],
  illegal: [
    'window.localStorage.getItem(\'flappycat.sneaky\')',
    'localStorage.setItem(\'raw.key\', 1)',
  ],
};
