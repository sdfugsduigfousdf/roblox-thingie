# Roblox Remote Agent - Admin
$ErrorActionPreference = "Continue"
$ConfigPath = Join-Path $PSScriptRoot "config.json"
$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$ServerUrl = $Config.serverUrl.TrimEnd("/")
$Secret = $Config.agentSecret
$Pin = $Config.pin
$script:PcState = "awake"
$script:SessionActive = $false

function Write-Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] $msg"
}

function Invoke-AgentApi($path, $body) {
    try {
        $headers = @{ "x-agent-secret" = $Secret; "Content-Type" = "application/json" }
        $json = $body | ConvertTo-Json -Depth 6 -Compress
        return Invoke-RestMethod -Uri "$ServerUrl$path" -Method POST -Headers $headers -Body $json -TimeoutSec 45
    } catch {
        Write-Log "API error: $($_.Exception.Message)"
        return $null
    }
}

function Send-Event($type, $detail = $null) {
    Invoke-AgentApi "/api/agent/event" @{ type = $type; detail = $detail } | Out-Null
}

function Get-Heartbeat {
    return Invoke-AgentApi "/api/agent/heartbeat" @{ pcState = $script:PcState; activity = $false }
}

function Wake-AndUnlock {
    Write-Log "Waking and unlocking with PIN..."
    $script:PcState = "waking"
    Send-Event "ready"
    try {
        $wakeCode = @'
using System;
using System.Runtime.InteropServices;
public class WakeHelper {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public static void Nudge() {
        mouse_event(0x0001, 1, 0, 0, 0);
        mouse_event(0x0001, -1, 0, 0, 0);
    }
}
'@
        Add-Type -TypeDefinition $wakeCode -ErrorAction SilentlyContinue
        [WakeHelper]::Nudge()
    } catch {}
    Start-Sleep -Seconds 2
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Start-Sleep -Milliseconds 800
        foreach ($c in $Pin.ToCharArray()) {
            [System.Windows.Forms.SendKeys]::SendWait([string]$c)
            Start-Sleep -Milliseconds 80
        }
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Write-Log "PIN submitted"
    } catch {
        Write-Log "SendKeys failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 4
    $script:PcState = "ready"
    Send-Event "awake"
    Send-Event "ready"
}

function Start-ProtonVpn {
    Write-Log "Starting Proton VPN..."
    $vpn = $Config.protonVpnPath
    if (Test-Path $vpn) {
        Start-Process -FilePath $vpn -WindowStyle Minimized
        Start-Sleep -Seconds 6
        Write-Log "Proton launched"
    } else {
        Write-Log "Proton path missing: $vpn"
    }
}

function Start-Roblox {
    Write-Log "Launching Roblox..."
    $path = $Config.robloxPath
    if (Test-Path $path) {
        Start-Process -FilePath $path
    } else {
        try { Start-Process "roblox-player:" } catch {
            Write-Log "Could not launch Roblox"
        }
    }
    Start-Sleep -Seconds 5
}

function Enforce-Soft {
    $kill = @("discord", "spotify", "steam", "medal")
    if ($Config.killList) { $kill = @($Config.killList) | ForEach-Object { $_.ToLower() } }
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        if ($kill -contains $_.ProcessName.ToLower()) {
            try {
                Write-Log "Killing $($_.ProcessName)"
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
}

function End-UserSession {
    Write-Log "Ending session - closing Roblox"
    foreach ($n in $Config.robloxExeNames) {
        $procName = $n -replace "\.exe$", ""
        Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    $script:SessionActive = $false
    $script:PcState = "awake"
    Send-Event "session_ended"
}

function Sleep-Pc {
    # Only brief S3 sleep; agent + server will wake on queue join
    Write-Log "Going to sleep (will wake on next queue join)"
    $script:PcState = "sleeping"
    Send-Event "sleeping"
    try {
        $powerCode = @'
using System;
using System.Runtime.InteropServices;
public class PowerHelper {
    [DllImport("powrprof.dll", SetLastError = true)]
    public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
}
'@
        Add-Type -TypeDefinition $powerCode -ErrorAction SilentlyContinue
        [PowerHelper]::SetSuspendState($false, $true, $false) | Out-Null
    } catch {
        rundll32.exe powrprof.dll,SetSuspendState 0,1,0
    }
}

Write-Log "Roblox Agent started. Server=$ServerUrl"
Write-Log "Owner PIN unlock ready"

while ($true) {
    $hb = Get-Heartbeat
    if ($null -eq $hb) {
        Start-Sleep -Seconds 8
        continue
    }

    # server can disable sleep
    $noSleep = $false
    if ($hb.PSObject.Properties.Name -contains "sleepDisabled") {
        $noSleep = [bool]$hb.sleepDisabled
    }

    $cmd = $hb.command
    if ($cmd) {
        Write-Log "Command: $($cmd.type)"
        switch ($cmd.type) {
            "prepare_session" {
                Wake-AndUnlock
                Start-ProtonVpn
                Start-Roblox
                $script:SessionActive = $true
                $script:PcState = "ready"
                Send-Event "ready"
            }
            "wake_only" {
                if ($script:PcState -eq "sleeping" -or $script:PcState -eq "unknown") {
                    Wake-AndUnlock
                }
            }
            "end_session" {
                End-UserSession
            }
            "sleep" {
                if (-not $script:SessionActive -and -not $noSleep) {
                    Sleep-Pc
                } else {
                    Write-Log "Sleep skipped (session active or sleep disabled)"
                }
            }
        }
    }

    if ($script:SessionActive) { Enforce-Soft }
    Start-Sleep -Seconds 5
}
