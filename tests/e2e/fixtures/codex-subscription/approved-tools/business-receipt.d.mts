export declare const RECEIPT_TOOL: 'workitem_read_receipt'

export type BusinessReceipt = {
  runId: string
  tool: string
  callId: string | number
  businessId: string
}

export type BusinessReceiptContext = 'mcp' | 'host-workflow-result'

export type BusinessReceiptProblem =
  | 'receipt_not_object'
  | 'receipt_fields_mismatch'
  | 'invalid_run_id'
  | 'invalid_tool'
  | 'invalid_call_id'
  | 'invalid_business_id'

export declare function isJsonRpcRequestId(value: unknown): value is string | number

export declare function businessReceiptProblem(
  value: unknown,
  context: BusinessReceiptContext
): BusinessReceiptProblem | null

export declare function createBusinessReceipt(receipt: BusinessReceipt): BusinessReceipt
