# CLI PROXY :: пульт в стиле keygen (cracked by v1tusha)
#
# Одно окно: статус прокси, живая статистика, переключение цели ремапа
# (*haiku* -> claude-opus-4-8 / claude-opus-5 / off) и ручки хеджа/пре-коммита —
# всё без рестарта. Дёргает готовые ручки proxy.js: GET /__state, POST /__config.
#
# PS 5.1 / Windows 11. Файл ДОЛЖЕН лежать в UTF-8 BOM, иначе кириллица и
# псевдографика выходят кракозябрами. Запуск: panel.bat (там ExecutionPolicy).

param([switch]$Once, [switch]$SelfTest)   # -Once: один кадр и выход; -SelfTest: проверить шаги ручек

$ErrorActionPreference = 'Stop'
$Base    = if ($env:PANEL_BASE) { $env:PANEL_BASE } else { 'http://127.0.0.1:8787' }
$Targets = @('claude-opus-4-8', 'claude-opus-5', 'off')
$W       = 52   # внутренняя ширина рамки
$here    = $PSScriptRoot

# Ручки хеджа шагают по готовым значениям, а не ±N: свободная арифметика даёт
# соблазн «дублей побольше», а это проверено и вредно — hedgeMs 5с при 5 попытках
# утраивает нагрузку голодающему шлюзу и ответы растут с 8с до 30с (15.08.2026).
# Пре-коммит наоборот должен быть МЕНЬШЕ терпения клиента (~18с до первого байта).
$HedgeSteps    = @(0, 8000, 12000, 20000, 30000)
$PreSteps      = @(0, 6000, 10000, 15000, 25000)
$AttemptSteps  = @(1, 2, 3, 4, 5)
$KnobNames     = @('дубль', 'попыток', 'пре-коммит')

# ---- VT: без ENABLE_VIRTUAL_TERMINAL_PROCESSING conhost не понимает ANSI ----
Add-Type -Name VT -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
public static void On(){ IntPtr h=GetStdHandle(-11); uint m; GetConsoleMode(h,out m); SetConsoleMode(h, m|0x0004); }
'@
[Win32.VT]::On()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$e = [char]27
$C = @{
  reset="$e[0m"; dim="$e[2m"; bold="$e[1m"; cyan="$e[96m"; mag="$e[95m"
  yel="$e[93m"; grn="$e[92m"; red="$e[91m"; gray="$e[90m"; wht="$e[97m"
}

$LOGO = @(
  ' ███  █     ███    ████  ████   ███  █   █ █   █',
  '█     █      █     █   █ █   █ █   █  █ █   █ █ ',
  '█     █      █     ████  ████  █   █   █     █  ',
  '█     █      █     █     █  █  █   █  █ █    █  ',
  ' ███  █████ ███    █     █   █  ███  █   █   █  '
)
$SCROLL = '   ***  ZERO-DEP SSE-KEEPALIVE PROXY  ***  CLAUDE => PROXY => AGENTROUTER  ***  cracked by v1tusha  ***'
$SW = 48

# ---- отрисовка -------------------------------------------------------------

# Видимая длина без ANSI — для добивки строки до ширины (иначе хвост прошлого
# кадра остаётся: рисуем поверх без очистки, чтобы не моргало).
function Vis($s) { ($s -replace "$e\[[0-9;]*m", '').Length }

# Обрезка по ВИДИМОЙ длине, не разрывая ANSI-последовательности. Без неё длинная
# строка вылезает за рамку, конхост переносит её на следующую строку, кадр
# становится выше окна и уезжает вниз — «терминал срёт текстом».
function Cut($s, $max) {
  if ((Vis $s) -le $max) { return $s }
  $out = ''; $vis = 0; $i = 0
  while ($i -lt $s.Length -and $vis -lt $max) {
    if ($s[$i] -eq $e) {
      $j = $s.IndexOf('m', $i)                    # ANSI целиком, в длину не идёт
      if ($j -lt 0) { $j = $s.Length - 1 }
      $out += $s.Substring($i, $j - $i + 1)
      $i = $j + 1
      continue
    }
    $out += $s[$i]; $i++; $vis++
  }
  $out + $C.reset
}

function Row($s) {
  $s = Cut $s $W
  $pad = $W - (Vis $s); if ($pad -lt 0) { $pad = 0 }
  $C.mag + '║' + $s + (' ' * $pad) + $C.mag + '║' + $C.reset
}
function Rule($l, $r) { $C.mag + $l + ('═' * $W) + $r + $C.reset }
function Led($on, $t) { if ($on) { $C.grn + '●' + $t + $C.reset } else { $C.red + '○' + $t + $C.reset } }

function Fmt-Up($ms) {
  $t = [int]($ms / 1000)
  '{0:00}:{1:00}:{2:00}' -f [int]($t / 3600), [int](($t % 3600) / 60), ($t % 60)
}

# Порог в секундах, 0 = ручка выключена. Целые: все шаги кратны секунде, а
# '{0:0.0}' на русской локали рисует «20,0с» — запятая тут только мешает.
function Fmt-S($ms) {
  if ([int]$ms -le 0) { 'off' } else { [string][int]([int]$ms / 1000) + 'с' }
}

# Ближайший к текущему значению шаг, затем сдвиг на $dir по списку (без заворота:
# заворот с 30с сразу в off слишком легко нажать случайно).
function Step-Value($list, $cur, $dir) {
  $i = 0; $best = [int]::MaxValue
  for ($j = 0; $j -lt $list.Count; $j++) {
    $d = [Math]::Abs([int]$list[$j] - [int]$cur)
    if ($d -lt $best) { $best = $d; $i = $j }
  }
  $i = [Math]::Min($list.Count - 1, [Math]::Max(0, $i + $dir))
  $list[$i]
}

function Draw($st, $cur, $msg, $phase, $knob) {
  # Масштаб под окно: ширина рамки = ширина консоли, тело растягиваем по высоте.
  # PANEL_COLS/PANEL_ROWS — только для проверки вёрстки на чужих размерах.
  try { $ww = if ($env:PANEL_COLS) { [int]$env:PANEL_COLS } else { [Console]::WindowWidth } } catch { $ww = 80 }
  try { $H  = if ($env:PANEL_ROWS) { [int]$env:PANEL_ROWS } else { [Console]::WindowHeight } } catch { $H = 30 }
  # Ширина рамки = ширина окна. Пола на 50 нет намеренно: раньше он делал кадр
  # ШИРЕ узкого окна, и оно сыпалось; теперь узкое окно просто режет логотип.
  $script:W = [Math]::Max(10, $ww - 2)
  $dim = "$($script:W)x$H"
  if ($script:lastDim -ne $dim) { [Console]::Write("$e[2J"); $script:lastDim = $dim }  # при ресайзе чистим хвосты старого кадра

  $up = $null -ne $st
  $active = if ($up) { [string]$st.cfg.remapModel } else { '' }
  $match  = if ($up) { [string]$st.cfg.remapMatch } else { 'haiku' }
  $host_  = if ($up) { ([uri]$st.upstream).Host } else { '—' }

  $k = { param($s) $C.yel + $s + $C.reset }

  # ---- шапка + статус + ремап + хедж + статистика.
  # Бюджет высоты жёсткий: логотип 5 строк + подвал 6, и всё вместе обязано влезть
  # в обычные 30 строк — иначе защита от прокрутки срезает логотип. Поэтому
  # декоративных пустых строк и отбивки под логотипом здесь нет.
  $top = @()
  $seps = @()   # места, куда вставить отбивку, если высота позволит
  $top += Rule '╔' '╗'
  foreach ($r in $LOGO) { $top += Row ('  ' + $C.cyan + $r + $C.reset) }
  $top += Row ('  ' + (& $k '↑↓') + ' цель   ' + (& $k 'SPACE') + ' 4-8⇄5   ' + (& $k 'ENTER') + ' применить   ' + (& $k 'R') + ' дефолт')
  $top += Row ('  ' + (& $k 'TAB') + ' ручка   ' + (& $k '←→') + ' значение   ' + (& $k 'P') + ' вкл/выкл   ' + (& $k 'Q') + ' выход')
  $top += Rule '╠' '╣'

  $top += Row ($C.yel + '  СТАТУС' + $C.reset + '   ' + $(if ($up) { $C.grn + '●RUNNING' } else { $C.red + '○STOPPED' }) + $C.reset)
  $top += Row ('   порт ' + $C.wht + ':' + ([uri]$Base).Port + $C.reset + '   ' + (Led $up 'LISTEN') + '    upstream ' + (Led $up 'OK'))
  if ($up) {
    $top += Row ('   аптайм ' + $C.wht + (Fmt-Up $st.stats.uptimeMs) + $C.reset + $C.gray + '    ·    ' + $host_ + $C.reset)
  } else {
    $top += Row ($C.red + '   прокси не запущен — нажми P' + $C.reset)
  }

  $seps += $top.Count
  $top += Row ($C.yel + '  РЕМАП' + $C.reset + '   ' + $C.gray + '*' + $match + '* ⇒ ?   (↑↓ выбор, Enter применить)' + $C.reset)
  for ($i = 0; $i -lt $Targets.Count; $i++) {
    $t = $Targets[$i]
    $mark = if ($i -eq $cur) { $C.yel + '▸' + $C.reset } else { ' ' }
    $col  = if ($i -eq $cur) { $C.bold } else { $C.dim }
    $label = if ($t -eq 'off') { 'off  (прозрачный прокси)' } else { $t }
    $tail = if ($t -eq $active) { $C.grn + '  ◀ активна' + $C.reset } else { '' }
    $top += Row ('   ' + $mark + ' ' + $col + $label + $C.reset + $tail)
  }

  # ---- ручки хеджа: живые значения из cfg, выбранная помечена ▸, LED = вкл/выкл
  $seps += $top.Count
  $top += Row ($C.yel + '  ХЕДЖ' + $C.reset + '   ' + $C.gray + 'дубль при тишине · пре-коммит' + $C.reset)
  if ($up) {
    $vals = @(
      (Fmt-S $st.cfg.hedgeMs),
      [string][int]$st.cfg.maxAttempts,
      (Fmt-S $st.cfg.preCommitMs)
    )
    $ons = @(([int]$st.cfg.hedgeMs -gt 0), $true, ([int]$st.cfg.preCommitMs -gt 0))
    $line = '  '
    for ($i = 0; $i -lt 3; $i++) {
      $mark = if ($i -eq $knob) { $C.yel + '▸' + $C.reset } else { ' ' }
      $col  = if ($i -eq $knob) { $C.bold + $C.wht } else { $C.dim }
      $led  = if ($ons[$i]) { $C.grn + '●' } else { $C.red + '○' }
      $line += ' ' + $mark + $led + $C.reset + $C.gray + $KnobNames[$i] + ' ' + $C.reset + $col + $vals[$i] + $C.reset + '  '
    }
    $top += Row $line
  } else {
    $top += Row ('   ' + $C.gray + '—' + $C.reset)
  }

  $seps += $top.Count
  $top += Row ($C.yel + '  СТАТИСТИКА' + $C.reset)
  if ($up) {
    $s = $st.stats
    $parts = @()
    foreach ($p in $s.byModel.PSObject.Properties) { $parts += (($p.Name -replace '^claude-', '') + ' ·' + $p.Value) }
    $top += Row ('   запросы ' + $C.wht + $s.requests + $C.reset + '   ремапы ' + $C.wht + $s.remaps + $C.reset + '   keepalive ' + $C.wht + $s.keepalives + $C.reset)
    # Разбивка по моделям приклеена сюда, а не отдельной строкой: экономим высоту.
    $top += Row ('   ретраи ' + $C.wht + $s.retries + $C.reset + '   хеджи ' + $C.wht + $s.hedges + $C.reset + '   ошибки ' + $(if ($s.errors -gt 0) { $C.red } else { $C.wht }) + $s.errors + $C.reset + '   ' + $C.gray + (($parts | Select-Object -First 3) -join '  ') + $C.reset)
  } else {
    $top += Row ('   ' + $C.gray + '—' + $C.reset); $top += Row ''
  }

  # ---- подвал: клавиши, сообщение, бегущая строка
  $foot = @()
  $foot += Rule '╠' '╣'
  $foot += Row ('  ' + $C.wht + 'Claude ' + $C.gray + '⇒ ' + $C.wht + 'PROXY ' + $C.gray + '⇒ ' + $C.wht + 'AGENTROUTER' + $C.gray + ' · cracked by v1tusha' + $C.reset)
  $foot += Rule '╠' '╣'
  $foot += Row ('  ' + $C.cyan + $msg + $C.reset)
  $sw = [Math]::Min($script:W - 6, $SCROLL.Length - 1)
  $win = $SCROLL.Substring($phase, [Math]::Min($sw, $SCROLL.Length - $phase))
  if ($win.Length -lt $sw) { $win += $SCROLL.Substring(0, $sw - $win.Length) }
  $foot += Row ('  ' + $C.grn + $win + $C.reset)
  $foot += Rule '╚' '╝'

  # ---- вписываем кадр в окно по высоте. Низкое окно — вторая причина «сыпется»:
  # кадр выше окна прокручивает консоль, и каждый кадр печатается заново ниже.
  # Жертвуем в таком случае логотипом, потом хвостом — подвал важнее красоты.
  $maxRows = [Math]::Max(3, $H - 1)
  $rows = $top + $foot

  # Остаток высоты сначала уходит на отбивку между секциями и только потом в низ:
  # слипшиеся секции выглядят сломанно, а пустота под ними — просто пустотой.
  $spare = $maxRows - $rows.Count
  if ($spare -gt 0 -and $seps.Count -gt 0) {
    $n = [Math]::Min($spare, $seps.Count)
    foreach ($idx in (($seps | Select-Object -First $n) | Sort-Object -Descending)) {
      $top = @($top[0..($idx - 1)]) + @(Row '') + @($top[$idx..($top.Count - 1)])
    }
    $rows = $top + $foot
  }

  if ($rows.Count -lt $maxRows) {
    $rows = $top + @(1..($maxRows - $rows.Count) | ForEach-Object { Row '' }) + $foot
  } elseif ($rows.Count -gt $maxRows) {
    $t = @($top[0]) + $top[($LOGO.Count + 1)..($top.Count - 1)]   # без логотипа
    $keep = $maxRows - $foot.Count
    if ($keep -lt 1) { $rows = $foot[0..($maxRows - 1)] }
    elseif ($t.Count -gt $keep) { $rows = $t[0..($keep - 1)] + $foot }
    else { $rows = $t + $foot }
  }

  [Console]::Write("$e[H" + ($rows -join "`n") + "$e[J")
}

# ---- сеть ------------------------------------------------------------------

function Get-State {
  try { Invoke-RestMethod -Uri "$Base/__state" -TimeoutSec 2 } catch { $null }
}
# Все ручки идут одним путём: proxy.js сам зажимает значения в разумные рамки.
function Set-Cfg($patch) {
  try {
    Invoke-RestMethod -Uri "$Base/__config" -Method Post -TimeoutSec 3 `
      -ContentType 'application/json' -Body ($patch | ConvertTo-Json -Compress) | Out-Null
    $true
  } catch { $false }
}
function Set-Target($m) { Set-Cfg @{ remapModel = $m } }

# Прокси — единственная кнопка: если не отвечает, поднимаем node СКРЫТО (без окна),
# лог в proxy.log. На выходе из панели не глушим — прокси держит Warp.
# ponytail: single-flight не защищён; два пульта разом = второй node (Get-State
# отсекает почти всегда, порт всё равно один — второй упадёт на EADDRINUSE в лог).
function Ensure-Proxy {
  if (Get-State) { return $true }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  $env:LOG_FILE = Join-Path $here 'proxy.log'
  # PORT обязателен: без него node сядет на свой дефолт 8787, а панель осталась бы
  # смотреть в порт из $Base — вечный ○STOPPED при живом прокси не на 8787.
  $env:PORT = ([uri]$Base).Port
  Start-Process -FilePath $node.Source -ArgumentList 'proxy.js' -WorkingDirectory $here -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 400; if (Get-State) { return $true } }
  $false
}

# Стоп: гасим процесс, слушающий наш порт (кем бы ни был запущен — панелью или proxy.bat).
function Get-ProxyPid {
  try { (Get-NetTCPConnection -LocalPort ([uri]$Base).Port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { $null }
}
function Stop-Proxy {
  $procId = Get-ProxyPid
  if ($procId) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; $true } else { $false }
}

# ---- главный цикл ----------------------------------------------------------

# ---- самопроверка шагов ручек: node-часть проверяет зажимы, тут — навигация ----
if ($SelfTest) {
  $fails = @()
  function Chk($name, $got, $want) {
    if ("$got" -ne "$want") { $script:fails += "$name : получили $got, ждали $want" }
  }
  Chk 'хедж 20с влево'      (Step-Value $HedgeSteps   20000 -1) 12000
  Chk 'хедж 20с вправо'     (Step-Value $HedgeSteps   20000  1) 30000
  Chk 'хедж на максимуме'   (Step-Value $HedgeSteps   30000  1) 30000   # без заворота в off
  Chk 'хедж на off'         (Step-Value $HedgeSteps       0 -1)     0
  Chk 'хедж из 9с (округл)' (Step-Value $HedgeSteps    9000  1) 12000   # ближайший 8с -> вправо
  Chk 'попыток 2 вправо'    (Step-Value $AttemptSteps     2  1)     3
  Chk 'попыток 1 влево'     (Step-Value $AttemptSteps     1 -1)     1
  Chk 'пре-коммит 10с влево'(Step-Value $PreSteps     10000 -1)  6000
  Chk 'формат 20000'        (Fmt-S 20000) '20с'
  Chk 'формат off'          (Fmt-S 0) 'off'

  # Инвариант рамки: ЛЮБАЯ строка — ровно $W видимых символов плюс два борта.
  # Нарушение = перенос в узком окне = кадр уезжает вниз и терминал сыпется
  # (баг 15.08.2026: строка управления и заголовок ХЕДЖ были длиннее рамки).
  $script:W = 40
  $nasty = @(
    'коротко',
    ('x' * 100),
    ($C.yel + ('слово ' * 20) + $C.reset),
    ($C.cyan + ('█' * 48) + $C.reset),                      # логотип шире рамки
    ('  ' + $C.yel + '↑↓' + $C.reset + ' цель   ' + $C.yel + 'SPACE' + $C.reset + ' 4-8⇄5   ' + $C.yel + 'ENTER' + $C.reset + ' применить   ' + $C.yel + 'R' + $C.reset + ' дефолт'),
    ($C.gray + ('─' * 200) + $C.reset),
    ($C.yel + 'a' + $C.reset) * 30                          # ANSI на каждом символе
  )
  foreach ($n in $nasty) { Chk ('ширина строки из ' + (Vis $n) + ' симв.') (Vis (Row $n)) 42 }
  Chk 'ширина Rule' (Vis (Rule '╔' '╗')) 42

  if ($fails.Count) { $fails | ForEach-Object { "FAIL: $_" }; exit 1 }
  'panel selftest OK'
  return
}

if ($Once) {
  $st = Get-State
  if (-not $st) {
    $st = [pscustomobject]@{
      cfg      = [pscustomobject]@{ remapModel = 'claude-opus-4-8'; remapMatch = 'haiku'
        hedgeMs = 20000; maxAttempts = 2; preCommitMs = 10000 }
      upstream = 'https://agentrouter.org'
      stats    = [pscustomobject]@{ uptimeMs = 862000; requests = 1284; remaps = 512; retries = 3; hedges = 17; errors = 0; keepalives = 8931
        byModel = [pscustomobject]@{ 'claude-opus-4-8' = 512; 'claude-opus-5' = 40 } }
    }
  }
  $ci = [Math]::Max(0, [array]::IndexOf($Targets, [string]$st.cfg.remapModel))
  Draw $st $ci $(if ($env:PANEL_MSG) { $env:PANEL_MSG } else { 'dry run' }) 0 0
  [Console]::Write("$e[0m`n")
  return
}

[Console]::CursorVisible = $false
[Console]::Write("$e[2J")
Write-Host 'CLI PROXY :: старт, поднимаю прокси...'
Ensure-Proxy | Out-Null
$cur = 0; $phase = 0; $knob = 0; $msg = 'подключаюсь...'
$st = Get-State
if ($st) { $cur = [Math]::Max(0, [array]::IndexOf($Targets, [string]$st.cfg.remapModel)); $msg = 'на связи' }
$lastPoll = [Environment]::TickCount

try {
  while ($true) {
    if (([Environment]::TickCount - $lastPoll) -ge 1000) {
      $st = Get-State; $lastPoll = [Environment]::TickCount   # ponytail: sync-опрос подвисит тикер ~2с если прокси лёг; job если надоест
    }
    $phase = ($phase + 1) % $SCROLL.Length
    Draw $st $cur $msg $phase $knob

    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        'UpArrow'   { $cur = ($cur - 1 + $Targets.Count) % $Targets.Count }
        'DownArrow' { $cur = ($cur + 1) % $Targets.Count }
        'Tab'       { $knob = ($knob + 1) % $KnobNames.Count }
        { $_ -in 'LeftArrow', 'RightArrow' } {
          # Ручки применяются сразу: это runtime-конфиг, Enter тут не нужен.
          $dir = if ($key.Key -eq 'RightArrow') { 1 } else { -1 }
          if (-not $st) {
            $msg = 'прокси не отвечает'
          } else {
            switch ($knob) {
              0 { $v = Step-Value $HedgeSteps   $st.cfg.hedgeMs     $dir
                  $msg = if (Set-Cfg @{ hedgeMs = $v })     { 'дубль при тишине: ' + (Fmt-S $v) } else { 'ошибка запроса к прокси' } }
              1 { $v = Step-Value $AttemptSteps $st.cfg.maxAttempts $dir
                  $msg = if (Set-Cfg @{ maxAttempts = $v }) { "попыток на запрос: $v" } else { 'ошибка запроса к прокси' } }
              2 { $v = Step-Value $PreSteps     $st.cfg.preCommitMs $dir
                  $msg = if (Set-Cfg @{ preCommitMs = $v }) { 'пре-коммит: ' + (Fmt-S $v) } else { 'ошибка запроса к прокси' } }
            }
            $st = Get-State; $lastPoll = [Environment]::TickCount
          }
        }
        'Enter' {
          $m = $Targets[$cur]
          $msg = if (Set-Target $m) { "применено: $m" } else { 'ошибка запроса к прокси' }
          $st = Get-State; $lastPoll = [Environment]::TickCount
        }
        'Spacebar' {
          # быстрый тумблер между двумя основными; из off/иного — на 4-8.
          $active = if ($st) { [string]$st.cfg.remapModel } else { '' }
          $next = if ($active -eq 'claude-opus-4-8') { 'claude-opus-5' } else { 'claude-opus-4-8' }
          $cur = [Math]::Max(0, [array]::IndexOf($Targets, $next))
          $msg = if (Set-Target $next) { "свитч: $next" } else { 'ошибка запроса к прокси' }
          $st = Get-State; $lastPoll = [Environment]::TickCount
        }
        'R' {
          $cur = 0
          $msg = if (Set-Target $Targets[0]) { 'сброшено на дефолт: ' + $Targets[0] } else { 'ошибка запроса к прокси' }
          $st = Get-State; $lastPoll = [Environment]::TickCount
        }
        'P' {
          if (Get-State) {
            $msg = if (Stop-Proxy) { 'прокси остановлен' } else { 'не нашёл процесс на порту' }
          } else {
            $msg = 'поднимаю прокси...'; Draw $st $cur $msg $phase $knob
            $msg = if (Ensure-Proxy) { 'прокси запущен' } else { 'не смог поднять (node в PATH?)' }
          }
          $st = Get-State; $lastPoll = [Environment]::TickCount
        }
        { $_ -in 'Q', 'Escape' } { throw 'quit' }
      }
    }
    Start-Sleep -Milliseconds 90
  }
} catch {
  if ("$_" -notmatch 'quit') { throw }
} finally {
  [Console]::CursorVisible = $true
  [Console]::Write("$e[0m`n")
}
