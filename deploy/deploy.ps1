# Deploy the committed HEAD to the VPS (cam.gikochan.net).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$key = "$HOME\.ssh\swash_deploy"
$hostname = 'debian@208.113.212.33'
$tgz = Join-Path $env:TEMP 'gikocam.tgz'
git -C $root archive --format=tar.gz -o $tgz HEAD
scp -i $key $tgz "${hostname}:/tmp/gikocam.tgz"
scp -i $key (Join-Path $PSScriptRoot 'remote-deploy.sh') "${hostname}:/tmp/gikocam-deploy.sh"
ssh -i $key $hostname 'bash /tmp/gikocam-deploy.sh'
