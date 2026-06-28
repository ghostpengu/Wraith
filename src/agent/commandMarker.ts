export const AGENT_DONE_MARKER = "__WRAITH_AGENT_DONE__";

export interface AgentCompletionMarker {
  token: string;
  exitCode: number;
}

export interface SplitMarkersResult {
  visible: string;
  markers: AgentCompletionMarker[];
  tail: string;
}

export function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

export function commandWithAgentFlags(command: string, label: string): string {
  void label;
  return command.trim();
}

export function createAgentRunToken(serial: () => number): string {
  return `run-${Date.now()}-${serial()}`;
}

export function buildAgentCommand(
  command: string,
  token: string,
  hookUrl: string,
  label: string
): string {
  const trimmed = commandWithAgentFlags(command, label);
  const hookEnv =
    `$env:WRAITH_AGENT_HOOK_URL='${psSingleQuote(hookUrl)}'; ` +
    `$env:WRAITH_AGENT_RUN_ID='${psSingleQuote(token)}'; ` +
    `$env:WRAITH_AGENT_LABEL='${psSingleQuote(label)}'; `;
  const markerExpression =
    "[string]::Concat('__WRAITH','_AGENT_DONE__',':','" +
    token +
    "',':',$wraithExitCode)";
  const line =
    "& { " +
    hookEnv +
    "$global:LASTEXITCODE = 0; " +
    trimmed +
    "; $wraithExitCode = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; Write-Host (" +
    markerExpression +
    ") }";

  return `${line}\r`;
}

export function findIncompleteAgentMarkerStart(value: string): number {
  const markerStart = value.lastIndexOf(AGENT_DONE_MARKER);
  if (markerStart !== -1 && !/[\r\n]/.test(value.slice(markerStart))) {
    return markerStart;
  }

  const maxPrefix = Math.min(value.length, AGENT_DONE_MARKER.length - 1);
  for (let len = maxPrefix; len > 0; len -= 1) {
    if (value.endsWith(AGENT_DONE_MARKER.slice(0, len))) {
      return value.length - len;
    }
  }

  return -1;
}

export function splitAgentCompletionMarkers(input: string): SplitMarkersResult {
  const markerPattern = /__WRAITH_AGENT_DONE__:([A-Za-z0-9_-]+):(-?\d+)\r?\n?/g;
  const markers: AgentCompletionMarker[] = [];
  let visible = "";
  let cursor = 0;
  let match: RegExpExecArray | null = null;

  while ((match = markerPattern.exec(input)) !== null) {
    visible += input.slice(cursor, match.index);
    markers.push({
      token: match[1],
      exitCode: Number.parseInt(match[2], 10),
    });
    cursor = match.index + match[0].length;
  }

  const remainder = input.slice(cursor);
  const incompleteStart = findIncompleteAgentMarkerStart(remainder);
  if (incompleteStart === -1) {
    return { visible: visible + remainder, markers, tail: "" };
  }

  return {
    visible: visible + remainder.slice(0, incompleteStart),
    markers,
    tail: remainder.slice(incompleteStart),
  };
}