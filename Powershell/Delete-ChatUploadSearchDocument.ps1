param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$DocumentId
)

$ErrorActionPreference = 'Stop'
$subscription = '03a40ea8-84cc-4182-85a2-a8d0c61ceb76'
$service = 'mds-ai-search-dev-wj'
$indexName = 'chat-upload-index'
$base = "https://$service.search.windows.net/indexes/$indexName"
$apiVersion = '2024-07-01'
$key = az search admin-key show --resource-group 'mds-rg' --service-name $service --subscription $subscription --query primaryKey -o tsv

try {
  if ($LASTEXITCODE -ne 0 -or -not $key) {
    throw 'Could not access a Search admin key.'
  }

  $headers = @{ 'api-key' = $key }
  $index = Invoke-RestMethod -Uri "${base}?api-version=$apiVersion" -Headers $headers -Method Get
  $keyField = $index.fields | Where-Object { $_.key }
  if ($index.name -cne $indexName -or $keyField.name -cne 'id') {
    throw 'Unexpected Search index or key field.'
  }

  $documentUri = "${base}/docs/$([uri]::EscapeDataString($DocumentId))?api-version=$apiVersion&`$select=id"
  $document = Invoke-RestMethod -Uri $documentUri -Headers $headers -Method Get
  if ($document.id -cne $DocumentId) {
    throw 'The retrieved document ID does not match the requested ID.'
  }

  $body = @{ value = @(@{ '@search.action' = 'delete'; id = $DocumentId }) } | ConvertTo-Json -Depth 4 -Compress
  $result = Invoke-RestMethod -Uri "${base}/docs/index?api-version=$apiVersion" -Headers $headers -ContentType 'application/json' -Method Post -Body $body
  if ($result.value.Count -ne 1 -or $result.value[0].key -cne $DocumentId -or $result.value[0].status -ne $true) {
    throw 'Search did not confirm successful deletion for the requested ID.'
  }

  try {
    $null = Invoke-RestMethod -Uri $documentUri -Headers $headers -Method Get
  } catch {
    if ([int]$_.Exception.Response.StatusCode -eq 404) {
      [pscustomobject]@{ Index = $indexName; DeletedKey = $DocumentId; VerifiedAbsent = $true }
      return
    }
    throw
  }

  throw 'Search accepted the delete, but the document is still present.'
} finally {
  Remove-Variable key,headers,body -ErrorAction SilentlyContinue
}