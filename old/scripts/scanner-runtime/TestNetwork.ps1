# Retain evidence rather than prune networks when Docker's default pool is full.
function Initialize-RunTestNetwork {
    $created = Invoke-RunDocker @('network','create','--label',"assetlibrary.test.run=$($Run.Id)",$Run.Id) -AllowFailure
    if ($created.Code -eq 0) { $Run.Network = $Run.Id; $Run.NetworkReused = $false; return }
    if ($created.Text -notmatch 'all predefined address pools have been fully subnetted') {
        throw 'Run-owned test network creation failed; see run logs'
    }
    $names = (Invoke-RunDocker @('network','ls','--filter','label=assetlibrary.test.run','--format','{{.Name}}')).Text -split "\r?\n"
    foreach ($name in ($names | Sort-Object)) {
        if ($name -notmatch '^al-(art|scan)-[0-9]{14}-[a-f0-9]{6}$') { continue }
        $network = ((Invoke-RunDocker @('network','inspect',$name)).Text | ConvertFrom-Json)[0]
        if ($network.Name -ne $name -or $network.Labels.'assetlibrary.test.run' -ne $name) { continue }
        $safe = $true
        foreach ($member in $network.Containers.PSObject.Properties) {
            # Full container inspect includes old-run environment secrets. Read
            # only non-secret ownership/state fields through Docker's formatter.
            $running = (Invoke-RunDocker @('inspect','--format','{{json .State.Running}}',$member.Name)).Text
            $labels = (Invoke-RunDocker @('inspect','--format','{{json .Config.Labels}}',$member.Name)).Text | ConvertFrom-Json
            if ($running -ne 'false' -or $labels.'assetlibrary.test.run' -ne $name) {
                $safe = $false; break
            }
        }
        if ($safe) { $Run.Network = $name; $Run.NetworkReused = $true; return }
    }
    throw 'Address pool exhausted and no quiescent owned Art/Scanner network is available'
}
