-- Legacy SQLite backfill before applying the current Prisma schema.
-- Run this against a copy of the old prod.db before `prisma db push`.

UPDATE customers
SET registeredAddress = address
WHERE address IS NOT NULL
  AND TRIM(address) <> ''
  AND (registeredAddress IS NULL OR TRIM(registeredAddress) = '');

UPDATE quotations
SET incoterm = deliveryTerms
WHERE deliveryTerms IS NOT NULL
  AND TRIM(deliveryTerms) <> ''
  AND (incoterm IS NULL OR TRIM(incoterm) = '');

UPDATE quotations
SET commonNote = CASE
  WHEN commonNote IS NULL OR TRIM(commonNote) = '' THEN '历史付款条款: ' || paymentTerms
  WHEN commonNote NOT LIKE '%历史付款条款:%' THEN commonNote || char(10) || '历史付款条款: ' || paymentTerms
  ELSE commonNote
END
WHERE paymentTerms IS NOT NULL
  AND TRIM(paymentTerms) <> '';

UPDATE inventory
SET conditionCode = status
WHERE status IS NOT NULL
  AND TRIM(status) <> ''
  AND (conditionCode IS NULL OR TRIM(conditionCode) = '');

UPDATE inventory
SET certificateType = CASE
  WHEN certificateStatus = 'HAS_8130' THEN 'FAA-8130-3'
  WHEN certificateStatus = 'HAS_EASA' THEN 'EASA-Form-1'
  WHEN certificateStatus IS NULL OR TRIM(certificateStatus) = '' THEN COALESCE(NULLIF(TRIM(certificateType), ''), 'NONE')
  ELSE certificateStatus
END
WHERE certificateStatus IS NOT NULL
   OR certificateType IS NULL
   OR TRIM(certificateType) = '';
