import type { StreamCompletionRequest } from './platform-bridge';
import { platformFetch } from './native-runtime';
function parseClaudeToolArgs(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
}
function claudeText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : '')).join('\n');
}
function claudeToolChoice(choice: unknown) {
    if (!choice) return undefined;
    if (typeof choice === 'object' && choice !== null) {
        const name = (choice as any).function?.name ?? (choice as any).name;
        if (typeof name === 'string' && name) return { type: 'tool', name };
    }
    if (choice === 'required' || choice === 'any') return { type: 'any' };
    if (choice === 'auto' || choice === 'none') return { type: choice };
    return undefined;
}
export function requestClaudeCompletion(request:StreamCompletionRequest) {
    const root=(request.baseUrl||'https://api.anthropic.com').replace(/\/+$/,''), url=root.endsWith('/messages')?root:root+(root.endsWith('/v1')?'/messages':'/v1/messages');
    const systems=request.messages.filter(row=>row.role==='system').map(row=>claudeText(row.content)).filter(Boolean).join('\n\n');
    const messages=request.messages.filter(row=>row.role!=='system').map(row=>row.role==='tool'?{role:'user',content:[{type:'tool_result',tool_use_id:row.tool_call_id,content:claudeText(row.content)}]}:'tool_calls' in row&&row.tool_calls?.length?{role:'assistant',content:[...(claudeText(row.content)?[{type:'text',text:claudeText(row.content)}]:[]),...row.tool_calls.map(call=>({type:'tool_use',id:call.id,name:call.function.name,input:parseClaudeToolArgs(call.function.arguments)}))]}:{role:row.role,content:claudeText(row.content)});
    const tools=Array.isArray(request.parameters.tools)?request.parameters.tools.map((tool:any)=>({name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters})):undefined;
    const tool_choice=claudeToolChoice(request.parameters.tool_choice);
    return platformFetch(url,{method:'POST',redirect:'error',credentials:'omit',signal:request.signal,headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01','x-api-key':request.apiKey,...request.includeHeaders},body:JSON.stringify({model:request.model,messages,system:systems||undefined,stream:request.stream!==false,max_tokens:request.parameters.max_tokens??4096,temperature:request.parameters.temperature,tools,...(tool_choice?{tool_choice}:{})})});
}
export function claudeReplyAdapter(){let toolIndex=-1;let inputTokens:number|undefined;let outputTokens:number|undefined;return (packet:any,streaming:boolean):any=>{
    if(packet.error)return {error:packet.error};if(!streaming){const parts=packet.content??[];return {choices:[{message:{content:parts.map(part=>part.text??'').join(''),reasoning_content:parts.map(part=>part.thinking??'').join(''),tool_calls:parts.filter(part=>part.type==='tool_use').map(part=>({id:part.id,type:'function',function:{name:part.name,arguments:JSON.stringify(part.input)}}))}}],...(packet.usage?{usage:{prompt_tokens:packet.usage.input_tokens,completion_tokens:packet.usage.output_tokens}}:{})};}
    if(packet.type==='message_start'&&packet.message?.usage?.input_tokens!==undefined)inputTokens=packet.message.usage.input_tokens;
    if(packet.type==='message_delta'&&packet.usage?.output_tokens!==undefined)outputTokens=packet.usage.output_tokens;
    const usage=inputTokens!==undefined||outputTokens!==undefined?{usage:{prompt_tokens:inputTokens,completion_tokens:outputTokens}}:{};
    const finish=packet.type==='message_delta'&&packet.delta?.stop_reason?{finish_reason:packet.delta.stop_reason==='max_tokens'?'length':'stop'}:{};
    const block=packet.content_block,change=packet.delta;const delta=block?.type==='tool_use'?{tool_calls:[{index:++toolIndex,id:block.id,type:'function',function:{name:block.name,arguments:''}}]}:change?.type==='input_json_delta'?{tool_calls:[{index:toolIndex,function:{arguments:change.partial_json}}]}:{content:change?.text??'',reasoning_content:change?.thinking??''};return {choices:[{index:0,...finish,delta}],...usage};};}
