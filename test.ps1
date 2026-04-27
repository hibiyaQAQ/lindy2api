$uri = "https://public.lindy.ai/api/v1/webhooks/lindy/2ae45c48-7f8a-4416-ba07-6a471a8fbf13"

$headers = @{
    Authorization = "Bearer 737289b3c859480009953b649b85167c0cd50b2df7703a17b5ac2e24b36d18d5"
}

$body = @{
    system = "你是一个严谨的中文助手。"
    prompt = "请用一句话解释 webhook 是什么。"
    jobId  = "test-001"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
    -Method Post `
    -Uri $uri `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body