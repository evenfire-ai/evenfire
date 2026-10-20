/**
 * The East Asian script of a text block or a document, and the face and
 * language each generator tags it with.
 */

export interface EastAsianScript {
  font: string
  lang: string
}

// Each face ships with Windows and with Word for Mac.
const JAPANESE: EastAsianScript = { font: 'Yu Gothic', lang: 'ja-JP' }
const KOREAN: EastAsianScript = { font: 'Malgun Gothic', lang: 'ko-KR' }
const CHINESE: EastAsianScript = { font: 'Microsoft YaHei', lang: 'zh-CN' }
const TRADITIONAL_CHINESE: EastAsianScript = { font: 'Microsoft JhengHei', lang: 'zh-TW' }
const HONG_KONG_CHINESE: EastAsianScript = { font: 'Microsoft JhengHei', lang: 'zh-HK' }

// Frequent characters written one way in Simplified Chinese and another in
// Traditional, the two lists in the same order; neither form is Japanese kanji
// that a line without kana could hold for both.
const SIMPLIFIED_ONLY =
  /[这们个说会国学时为与来对发从实动经过还进现么没样关长门问题应见业开东头车书买卖电话语让认识请读写观点体产务员达区级际华结统计设资价变报农习乐网码帮]/gu
const TRADITIONAL_ONLY =
  /[這們個說會國學時為與來對發從實動經過還進現麼沒樣關長門問題應見業開東頭車書買賣電話語讓認識請讀寫觀點體產務員達區級際華結統計設資價變報農習樂網碼幫]/gu
/** Characters of written Cantonese, which Hong Kong text holds. */
const CANTONESE = /[嘅咗唔喺冇嚟啲佢哋嘢嗰]/u

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * The East Asian face and language a block names for itself, chosen from the
 * whole block so Han characters in Japanese text get the Japanese face:
 * Japanese with kana, Korean with Hangul. Han characters alone may be any of
 * the three, so such a block takes the document's (documentEastAsianScript).
 */
export function eastAsianScript(text: string): EastAsianScript | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return JAPANESE
  if (/\p{Script=Hangul}/u.test(text)) return KOREAN
  return undefined
}

/**
 * The East Asian script of a whole document: that of the lines holding most of
 * its CJK characters, where a line of Han characters alone counts as Chinese.
 * Chinese is Traditional when its lines hold more characters only Traditional
 * writes than ones only Simplified writes, and Hong Kong's when they also hold
 * written Cantonese; otherwise Simplified, as before.
 */
export function documentEastAsianScript(text: string): EastAsianScript | undefined {
  const counts = new Map<EastAsianScript, number>()
  let traditional = 0
  let simplified = 0
  let cantonese = false
  for (const line of text.split('\n')) {
    const cjk = line.match(CJK_CHAR)?.length ?? 0
    if (cjk === 0) continue
    const script = eastAsianScript(line) ?? CHINESE
    counts.set(script, (counts.get(script) ?? 0) + cjk)
    if (script !== CHINESE) continue
    traditional += line.match(TRADITIONAL_ONLY)?.length ?? 0
    simplified += line.match(SIMPLIFIED_ONLY)?.length ?? 0
    cantonese ||= CANTONESE.test(line)
  }
  let best: EastAsianScript | undefined
  for (const script of [JAPANESE, KOREAN, CHINESE]) {
    if ((counts.get(script) ?? 0) > (best ? (counts.get(best) ?? 0) : 0)) best = script
  }
  if (best === CHINESE && traditional > simplified) {
    return cantonese ? HONG_KONG_CHINESE : TRADITIONAL_CHINESE
  }
  return best
}
