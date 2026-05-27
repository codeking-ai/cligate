param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$Url = "http://127.0.0.1:8765",
  [string]$Text = "",
  [string]$Key = "",
  [string]$Keys = "",
  [double]$X = 0,
  [double]$Y = 0,
  [string]$Space = "screen",
  [string]$Button = "left",
  [int]$Clicks = 1,
  [int]$Amount = 0,
  [int]$Ms = 0,
  [string]$Backend = "auto",
  [int]$PreviewWidth = 0,
  [string]$Region = "",                 # "x,y,w,h"
  [switch]$Inline,
  # launch
  [string]$Path = "",
  [string]$Query = "",
  # focus / windows
  [string]$Title = "",
  [string]$Match = "contains",
  [int]$Hwnd = 0,
  # uia
  [string]$WindowTitle = "",
  [string]$WindowClass = "",
  [string]$WindowMatch = "contains",
  [int]$WindowHwnd = 0,
  [string]$ControlType = "",
  [string]$Name = "",
  [string]$NameMatch = "contains",
  [string]$AutomationId = "",
  [string]$ClassName = "",
  [int]$SearchDepth = 0,
  [int]$TimeoutMs = 0,
  [int]$MaxDepth = 0,
  [string]$Act = "",                     # for /ui/act: click|set_value|append|get_value|get_text|focus|send_keys
  [string]$SendKeys = ""
)

function Invoke-AgentPost {
  param([string]$Path, [hashtable]$Body)
  $json = $Body | ConvertTo-Json -Depth 10
  Invoke-RestMethod -Method Post -Uri "$Url$Path" -ContentType "application/json" -Body $json
}

function Invoke-AgentGet {
  param([string]$Path)
  Invoke-RestMethod -Method Get -Uri "$Url$Path"
}

function ScreenshotBody {
  $body = @{ backend = $Backend }
  if ($PreviewWidth -gt 0) { $body.preview_width = $PreviewWidth }
  if ($Region) {
    $parts = $Region.Split(",") | ForEach-Object { [int]$_.Trim() }
    if ($parts.Count -ne 4) { throw "Region must be 'x,y,w,h'" }
    $body.region = $parts
  }
  if ($Inline) { $body.inline = $true }
  return $body
}

function UiaSpec {
  $body = @{}
  if ($WindowHwnd -gt 0) { $body.window_hwnd = $WindowHwnd }
  if ($WindowTitle)  { $body.window_title  = $WindowTitle }
  if ($WindowClass)  { $body.window_class  = $WindowClass }
  if ($WindowMatch)  { $body.window_match  = $WindowMatch }
  if ($ControlType)  { $body.control_type  = $ControlType }
  if ($Name)         { $body.name          = $Name }
  if ($NameMatch)    { $body.name_match    = $NameMatch }
  if ($AutomationId) { $body.automation_id = $AutomationId }
  if ($ClassName)    { $body.class_name    = $ClassName }
  if ($SearchDepth -gt 0) { $body.search_depth = $SearchDepth }
  if ($TimeoutMs   -gt 0) { $body.timeout_ms   = $TimeoutMs }
  if ($MaxDepth    -gt 0) { $body.max_depth    = $MaxDepth }
  if ($Text)         { $body.text          = $Text }
  if ($Act)          { $body.act           = $Act }
  if ($SendKeys)     { $body.keys          = $SendKeys }
  return $body
}

switch ($Action) {
  "health"     { Invoke-AgentGet  "/health" }
  "active"     { Invoke-AgentGet  "/active" }
  "windows"    {
    if ($Title) { Invoke-AgentPost "/windows" @{ title = $Title; match = $Match } }
    else        { Invoke-AgentGet  "/windows" }
  }
  "screenshot" { Invoke-AgentPost "/screenshot" (ScreenshotBody) }
  "move"       { Invoke-AgentPost "/move"  @{ x = $X; y = $Y; space = $Space } }
  "click"      { Invoke-AgentPost "/click" @{ x = $X; y = $Y; space = $Space; button = $Button; clicks = $Clicks } }
  "type"       { Invoke-AgentPost "/type"  @{ text = $Text } }
  "press"      { Invoke-AgentPost "/press" @{ key = $Key } }
  "hotkey"     { Invoke-AgentPost "/hotkey" @{ keys = $Keys } }
  "scroll"     { Invoke-AgentPost "/scroll" @{ amount = $Amount } }
  "wait"       { Invoke-AgentPost "/wait"  @{ ms = $Ms } }
  "launch"     {
    $b = @{}
    if ($Path)  { $b.path  = $Path }
    if ($Query) { $b.query = $Query }
    Invoke-AgentPost "/launch" $b
  }
  "focus"      {
    if ($Hwnd -gt 0) { Invoke-AgentPost "/focus" @{ hwnd = $Hwnd } }
    else             { Invoke-AgentPost "/focus" @{ title = $Title; match = $Match } }
  }
  "ui-find"    { Invoke-AgentPost "/ui/find" (UiaSpec) }
  "ui-act"     { Invoke-AgentPost "/ui/act"  (UiaSpec) }
  "ui-tree"    { Invoke-AgentPost "/ui/tree" (UiaSpec) }
  default      { throw "Unknown action: $Action" }
}
