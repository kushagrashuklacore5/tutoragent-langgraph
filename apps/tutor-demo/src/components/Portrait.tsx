import { useId } from 'react'

/** Vidya, the demo's original guide character: an inline, resolution-independent illustration animated with CSS only. */
export function Portrait({ compact = false }: { compact?: boolean }) {
  const id = useId().replace(/:/g, '')
  const u = (n: string) => `url(#${id}-${n})`
  const eye = (
    <g>
      <path d="M186 266 Q214 236 252 258 Q232 284 202 282 Q192 278 186 266Z" fill="#f6f8ff" />
      <g clipPath={u('eye')}>
        <ellipse cx="222" cy="262" rx="17" ry="22" fill={u('iris')} />
        <ellipse cx="222" cy="264" rx="8" ry="11" fill="#071029" />
        <ellipse cx="222" cy="275" rx="11" ry="5" fill="#59e6f2" opacity=".55" />
        <circle cx="216" cy="253" r="5.2" fill="#fff" />
        <circle cx="229" cy="270" r="2" fill="#fff" opacity=".85" />
        <path d="M184 240 H256 V256 Q218 240 186 268Z" fill="#0b1030" opacity=".2" />
      </g>
      <path className="td-lid" d="M186 266 Q214 236 252 258 Q232 284 202 282 Q192 278 186 266Z" fill={u('skin')} />
      <path d="M180 270 Q190 250 208 243 Q232 234 256 257 Q234 245 212 249 Q195 254 186 270 L180 276Z" fill="#10163a" />
      <path d="M204 283 Q222 287 238 277" stroke="#8f6f73" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M186 226 Q214 208 248 222" stroke="#1a2152" strokeWidth="4" fill="none" strokeLinecap="round" />
      <ellipse cx="205" cy="304" rx="20" ry="8" fill="#f08f97" opacity=".2" />
    </g>
  )
  return (
    <svg className={`td-portrait${compact ? ' is-compact' : ''}`} viewBox="0 0 520 640" role="img" aria-label="Vidya, the Ek Bharat.AI Tutor guide">
      <defs>
        <radialGradient id={`${id}-halo`} cx="50%" cy="42%" r="55%"><stop offset="0" stopColor="#3f7bff" stopOpacity=".5" /><stop offset=".55" stopColor="#2746b8" stopOpacity=".17" /><stop offset="1" stopColor="#070b18" stopOpacity="0" /></radialGradient>
        <linearGradient id={`${id}-skin`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffe3cf" /><stop offset=".62" stopColor="#f3c5a8" /><stop offset="1" stopColor="#cf9a8c" /></linearGradient>
        <linearGradient id={`${id}-neck`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b98284" /><stop offset=".45" stopColor="#e7b79e" /><stop offset="1" stopColor="#f0c6ad" /></linearGradient>
        <linearGradient id={`${id}-hair`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2a3f96" /><stop offset=".42" stopColor="#141b4d" /><stop offset="1" stopColor="#0a0d28" /></linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#6fb5ff" stopOpacity="0" /><stop offset=".5" stopColor="#8fd6ff" stopOpacity=".75" /><stop offset="1" stopColor="#6fb5ff" stopOpacity="0" /></linearGradient>
        <linearGradient id={`${id}-coat`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#26336f" /><stop offset=".5" stopColor="#141c47" /><stop offset="1" stopColor="#0a0f2b" /></linearGradient>
        <linearGradient id={`${id}-shirt`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e9f1ff" /><stop offset="1" stopColor="#9fb4e6" /></linearGradient>
        <radialGradient id={`${id}-iris`} cx="50%" cy="35%" r="70%"><stop offset="0" stopColor="#1b3f9e" /><stop offset=".6" stopColor="#2b7fe8" /><stop offset="1" stopColor="#3fe0ee" /></radialGradient>
        <clipPath id={`${id}-eye`}><path d="M186 266 Q214 236 252 258 Q232 284 202 282 Q192 278 186 266Z" /></clipPath>
      </defs>

      <circle className="td-p-halo" cx="260" cy="270" r="256" fill={u('halo')} />
      <g className="td-p-rings" fill="none">
        <circle cx="260" cy="262" r="214" stroke="#4d8dff" strokeOpacity=".3" strokeDasharray="2 9" />
        <path d="M78 150 A214 214 0 0 1 340 64" stroke="#3fe0ee" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
        <path d="M470 300 A214 214 0 0 1 380 440" stroke="#6d7bff" strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
      </g>
      <g className="td-p-motes" fill="#8fd6ff">
        <circle cx="78" cy="236" r="2.4" /><circle cx="446" cy="172" r="3" /><circle cx="118" cy="104" r="1.8" /><circle cx="470" cy="382" r="2.2" /><circle cx="52" cy="402" r="1.8" /><circle cx="396" cy="72" r="1.8" />
      </g>

      <g className="td-p-bust">
        <path className="td-p-hairback" d="M148 232 C136 118 206 66 262 66 C334 66 388 120 374 236 C382 332 402 412 428 486 C386 510 344 478 332 424 L188 424 C176 478 134 510 92 486 C118 412 140 326 148 232Z" fill={u('hair')} />
        <path d="M54 640 C64 548 126 486 212 456 L238 424 L282 424 L308 456 C394 486 456 548 466 640Z" fill={u('coat')} />
        <path d="M222 448 L260 540 L298 448 L282 420 L238 420Z" fill={u('shirt')} />
        <path d="M232 346 L228 424 C238 448 282 448 292 424 L288 346Z" fill={u('neck')} />
        <path d="M212 456 L238 416 L262 520 L232 640 L172 640 C180 570 192 510 212 456Z" fill="#1d2860" />
        <path d="M308 456 L282 416 L258 520 L288 640 L348 640 C340 570 328 510 308 456Z" fill="#18214f" />
        <g fill="none" stroke="#45dcea" strokeLinecap="round">
          <path d="M238 418 L262 520 L236 640" strokeOpacity=".85" strokeWidth="1.7" />
          <path d="M282 418 L258 520 L284 640" strokeOpacity=".85" strokeWidth="1.7" />
          <path d="M116 560 L150 530 H182 L196 516" strokeOpacity=".5" />
          <path d="M404 560 L370 530 H338 L324 516" strokeOpacity=".5" />
          <path d="M100 604 H148 L164 590" strokeOpacity=".32" />
          <path d="M420 604 H372 L356 590" strokeOpacity=".32" />
        </g>
        <g fill="#45dcea"><circle cx="196" cy="516" r="2.6" /><circle cx="324" cy="516" r="2.6" /><circle cx="164" cy="590" r="2" /><circle cx="356" cy="590" r="2" /></g>
        <g transform="translate(338 566)"><path d="M0-15 L13-7.5 V7.5 L0 15 L-13 7.5 V-7.5Z" fill="#0d1540" stroke="#6fa6ff" /><path d="M-5 5 L0-7 L5 5 M-3 1 H3" fill="none" stroke="#45dcea" strokeWidth="1.5" strokeLinecap="round" /></g>

        <g className="td-p-head">
          <path d="M170 262 C160 258 156 276 164 292 C168 302 176 306 182 302Z" fill="#e7b79e" />
          <path d="M350 262 C360 258 364 276 356 292 C352 302 344 306 338 302Z" fill="#d9a690" />
          <path d="M174 238 C174 172 214 128 260 128 C306 128 346 172 346 238 C346 290 324 332 288 362 C276 372 267 378 260 378 C253 378 244 372 232 362 C196 332 174 290 174 238Z" fill={u('skin')} />
          <path d="M346 238 C346 290 324 332 288 362 C276 372 267 378 260 378 C300 340 326 300 330 220 C340 214 346 224 346 238Z" fill="#c98f85" opacity=".28" />
          {eye}
          <g transform="matrix(-1 0 0 1 520 0)">{eye}</g>
          <path d="M261 296 Q266 314 258 320 Q262 323 267 320" fill="none" stroke="#b77f76" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M240 344 Q260 356 282 342" fill="none" stroke="#a65c64" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M250 352 Q261 357 272 351" fill="none" stroke="#e8a5a2" strokeWidth="2" strokeLinecap="round" />
          <path className="td-p-lock" d="M172 226 C156 290 164 356 142 420 C178 398 198 344 194 266Z" fill={u('hair')} />
          <path className="td-p-lock is-right" d="M348 226 C364 290 356 356 378 420 C342 398 322 344 326 266Z" fill={u('hair')} />
          <path d="M164 246 C152 150 208 86 262 86 C326 86 370 150 356 250 C348 222 336 196 320 176 C318 202 306 220 290 232 C296 204 288 180 276 158 C268 192 246 218 218 232 C228 210 230 190 226 170 C208 194 192 220 186 258 C178 254 170 250 164 246Z" fill={u('hair')} />
          <path className="td-p-sheen" d="M190 150 C216 116 252 106 296 116 C266 118 228 132 204 168Z" fill={u('shine')} />
          <path d="M176 184 C182 150 198 130 216 116" stroke="#4a6fd0" strokeOpacity=".5" fill="none" strokeWidth="1.5" />
          <path d="M152 244 C150 176 196 104 262 98" stroke="#45dcea" strokeOpacity=".75" strokeWidth="3" fill="none" strokeLinecap="round" />
          <rect x="143" y="240" width="22" height="48" rx="10" fill="#10183f" stroke="#6fa6ff" />
          <circle className="td-p-beacon" cx="154" cy="264" r="4" fill="#45dcea" />
        </g>
      </g>
    </svg>
  )
}
