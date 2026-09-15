$resourceGroup = "mds-rg"
$staticWebAppName = "mds-staticwebapp"

$principalId = az staticwebapp show `
  --name $staticWebAppName `
  --resource-group $resourceGroup `
  --query "identity.principalId" `
  -o tsv
#---
$graphSpId = az ad sp list `
  --filter "appId eq '00000003-0000-0000-c000-000000000000'" `
  --query "[0].id" `
  -o tsv
#---
$graphSp = az rest `
  --method GET `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId" `
  | ConvertFrom-Json

$userReadBasicAllId = ($graphSp.appRoles | Where-Object {
  $_.value -eq "User.ReadBasic.All" -and $_.allowedMemberTypes -contains "Application"
}).id

$groupMemberReadAllId = ($graphSp.appRoles | Where-Object {
  $_.value -eq "GroupMember.Read.All" -and $_.allowedMemberTypes -contains "Application"
}).id
#---
$body1 = @{
  principalId = $principalId
  resourceId  = $graphSpId
  appRoleId   = $userReadBasicAllId
} | ConvertTo-Json -Compress

az rest `
  --method POST `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
  --headers "Content-Type=application/json" `
  --body $body1
#---
$body2 = @{
  principalId = $principalId
  resourceId  = $graphSpId
  appRoleId   = $groupMemberReadAllId
} | ConvertTo-Json -Compress

az rest `
  --method POST `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
  --headers "Content-Type=application/json" `
  --body $body2
#---
az rest `
  --method GET `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
  | ConvertFrom-Json
#---
$assignments = az rest `
  --method GET `
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
  | ConvertFrom-Json

$assignments.value | ForEach-Object {
  $assignment = $_
  $role = $graphSp.appRoles | Where-Object { $_.id -eq $assignment.appRoleId }

  [pscustomobject]@{
    AppRoleId = $assignment.appRoleId
    RoleValue = $role.value
  }
}