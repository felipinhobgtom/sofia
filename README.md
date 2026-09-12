# SofIA — CloudSix

**Secretária virtual e sistema de gestão inteligente, com abordagem WhatsApp-First, Web-Extended.**

> **Status do repositório:** MVP conversacional por áudio em TypeScript, com a sua própria conta do WhatsApp conectada por Baileys e IA pela Groq. Você envia a voz, a SofIA responde em texto. O ERP/CRM e o dashboard descritos no documento oficial continuam como escopo planejado, não funcionalidades já entregues.

## Referências do projeto

- **Fonte oficial de escopo:** [Descrição do Agente CloudSix — aba SofIA](https://docs.google.com/document/d/1bdl3aO33JhW88fJatrre9h1xCd7R32TM6FBTO6l92k0/edit?tab=t.jo3qj0l5spdi).
- **Arquitetura atual e evolução:** [Conector Baileys, operação e avaliação das ferramentas](ARQUITETURA.md).

O escopo de gestão abaixo resume o documento oficial. Usar a própria conta com Baileys, em vez da Cloud API, é a escolha explícita para este MVP. As propostas futuras de frameworks e infraestrutura em ARQUITETURA.md não são decisões atribuídas ao documento de produto.

## MVP conversacional por áudio — usar agora

O conector usa a **sua própria conta do WhatsApp**, vinculada como um dispositivo pelo Baileys, e conversa com a **API Groq**. O **OpenAI Agents SDK** e o pacote npm `openai` permanecem como bibliotecas open source de orquestração/cliente, configuradas exclusivamente para `https://api.groq.com/openai/v1`: a conversa usa **Chat Completions**, não Responses, e o tracing está desativado. Não há chamadas, traces, consumo de créditos ou fallback para a API OpenAI.

**Um áudio novo no chat autorizado é o pedido**, sem palavra-chave ou mensagem de ativação. A SofIA transcreve a voz e responde em texto; também pode analisar uma imagem ou PDF ao qual esse áudio esteja respondendo. Texto, foto e PDF enviados sozinhos não ativam o agente. **Não cadastra clientes, não altera estoque ou caixa, não muda o Kanban, não agenda lembretes e não gera PDFs de orçamento.** Pode preparar um rascunho textual, mas isso não equivale a salvar ou enviar uma proposta a um cliente.

### Requisitos e instalação

- **Node.js 24 ou superior** e npm. O TypeScript é executado pelo suporte nativo de remoção de tipos do Node; não há etapa de build para iniciar.
- Sua conta do WhatsApp no celular, com acesso a **Dispositivos conectados**.
- Internet e um processo Node em execução para receber comandos e responder.
- Chave da API Groq, obtida no [console de chaves](https://console.groq.com/keys), com acesso e cota disponível para os modelos configurados. Podem existir cotas gratuitas e limites de uso; não há promessa de uso gratuito ilimitado. **A chave não é necessária para apenas parear.**

Não é preciso webhook, HTTPS público, aplicativo de desenvolvedor Meta, número empresarial nem token do WhatsApp Business. PostgreSQL, S3, Next.js e Auth0 pertencem à proposta do produto completo, não à instalação deste MVP.

```sh
npm ci
```

O repositório inclui `package-lock.json`: use `npm ci` para reproduzir as versões. Sem lockfile, use `npm install`. O pacote `@whiskeysockets/baileys` está **fixado em `7.0.0-rc14`**, uma **release candidate**, não uma promessa de estabilidade. Não troque a versão por `latest` sem revisar as mudanças. A instalação reaplica, via `patch-package` no `postinstall`, as correções de dependências em `patches/`: ajustes de tipos e remoção de dados criptográficos dos logs, preservando os eventos de diagnóstico. Preserve esse hook.

Na primeira instalação, **somente se `.env` ainda não existir**, copie `.env.example` para `.env` e edite-o localmente; nunca publique a chave. **Para migrar uma instalação existente, preserve seu `.env`: basta ter `GROQ_KEY` nele.** Os modelos abaixo já são os padrões do código. As antigas variáveis `OPENAI_*` não são mais usadas; não é preciso substituir o arquivo, alterar a allowlist, apagar o SQLite ou parear novamente.

Os valores de referência são:

| Variável | Valor / uso |
| --- | --- |
| `GROQ_KEY` | Sua chave local; obrigatória em `npm start`, dispensada em `npm run pair`. O nome é exatamente `GROQ_KEY`, não `GROQ_API_KEY`. |
| `GROQ_MODEL` | `qwen/qwen3.6-27b`, modelo de texto e visão atualmente em preview, usado em modo não pensante (`reasoning_effort=none`), para a conversa e a análise das referências citadas. |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo` para os pedidos por áudio, com transcrição em português (`language=pt`, fixo no conector; não exige outra variável de ambiente). |
| `WHATSAPP_ALLOWED_JIDS` | Vazio: somente a conversa consigo mesmo. Lista opcional de JIDs privados separados por vírgula. |
| `DATABASE_PATH` | `./data/sofia.sqlite`; sessão do dispositivo, inbox/deduplicação e contexto textual. |

### Vincular e iniciar

1. **Se ainda não houver uma sessão vinculada**, execute `npm run pair`. No celular, abra **WhatsApp → Dispositivos conectados → Conectar dispositivo** e leia o QR exibido no terminal. Trate o QR como uma credencial temporária; não o compartilhe.
2. O comando de pareamento termina quando a conexão é estabelecida e a sessão é salva. Ele **não chama provedores de IA nem precisa de `GROQ_KEY`**.
3. Com `GROQ_KEY` presente no `.env`, execute `npm start`. Mantenha esse processo ativo. Reiniciar ou trocar o provedor de IA reutiliza a sessão local; não exige outro QR enquanto o vínculo for válido.
4. Use `Ctrl+C` para parar. Isso não desvincula a conta nem apaga a sessão. Para revogar o acesso, remova o dispositivo pelo WhatsApp no celular. Não há logout ou reset automático.

Use **um único processo por conta/banco**; não rode `pair` e `start` ao mesmo tempo nem compartilhe a mesma base entre instâncias.

### Falar com a SofIA

Por padrão, abra a conversa **com você mesmo** no WhatsApp e **envie uma mensagem de voz normalmente**. Não precisa escrever antes nem citar o próprio áudio. Por exemplo, grave:

> “Prepare um rascunho de orçamento para pintar uma sala. Pergunte os dados que faltarem.”

- **Só voz:** envie o áudio com seu pedido. Ele é transcrito e a SofIA responde em texto. Para continuar, envie outro áudio; pode usar **Responder** no texto do bot. O texto citado não vira anexo: a continuidade usa o histórico textual recente.
- **Foto:** envie a foto para você mesmo. Use **Responder** nessa foto e grave uma mensagem de voz como “Extraia os itens e valores deste recibo”. O áudio é a instrução e a foto citada é a referência.
- **PDF:** envie o documento, use **Responder** nele e grave “Resuma este PDF e destaque as condições de pagamento”.
- **Texto, foto, PDF ou legenda sem áudio:** não iniciam processamento. Apenas imagem/PDF são referências de mídia aceitas; texto citado por um áudio é ignorado como anexo, sem impedir o pedido por voz. Citar outro áudio ou vídeo gera um aviso de referência não suportada.

Enquanto o processo estiver ativo, **todo áudio novo elegível no chat autorizado é tratado como um pedido à IA**. Não envie ali áudios que não queira compartilhar com a Groq. Não existe janela de ativação para mensagens seguintes: cada áudio é um pedido independente, com o contexto recente da mesma conversa. Respostas do bot são textuais e, portanto, não são confundidas com novos áudios nem criam um ciclo de respostas.

Para habilitar **outras conversas privadas**, inclua os identificadores exatos em `WHATSAPP_ALLOWED_JIDS`, por exemplo:

```dotenv
WHATSAPP_ALLOWED_JIDS=5511999999999@s.whatsapp.net,123456789@lid
```

Esses valores são exemplos, não contatos configurados. Um JID de telefone (`@s.whatsapp.net`) e um LID (`@lid`) são identidades de domínios diferentes: números iguais não os tornam equivalentes. Nessas conversas, **somente áudios recebidos da outra pessoa** são processados; mensagens enviadas por você a outros contatos são ignoradas. A resposta volta à conversa que recebeu o áudio. Ao habilitar um contato, os novos áudios dele passam a ser pedidos à IA: avise-o antes sobre o envio de voz e referências citadas à Groq, inclusive páginas renderizadas de PDFs.

Grupos, status, newsletters, conversas não autorizadas, mensagens sem áudio e eventos de histórico (`append`) são ignorados. Não há importação do histórico pessoal nem encaminhamento indiscriminado das conversas. Mídia de visualização única não é aberta; vídeos ainda não fazem parte do conector. Só o áudio autorizado, a imagem citada ou as páginas renderizadas/texto do PDF citado, e o contexto textual desses pedidos seguem para a Groq; o código-fonte do projeto não é enviado.

O limite é de **20 MiB por anexo**, com download de até **60 segundos**. Imagens aceitas: JPEG, PNG e WebP; documentos: PDF. Áudios aceitos: OGG/Opus, MP3, MP4/M4A, WAV, WebM e FLAC. Não há conversão automática de AAC/AMR nem dependência de FFmpeg; tipos não suportados são recusados. Veja os limites de interpretação e de provedor em [ARQUITETURA.md](ARQUITETURA.md).

**PDFs não são enviados como arquivos brutos à API.** Como a Groq não oferece entrada PDF nativa nesse caminho, o conector rasteriza **todas as páginas localmente**, usando `pdfjs-dist` e `@napi-rs/canvas`, e envia as imagens para visão em lotes de **até 3 páginas**, com síntese dos resultados em documentos maiores. Isso preserva a referência visual de páginas digitalizadas, tabelas e imagens, em vez de reduzir o documento somente ao texto extraível. Não há corte silencioso de páginas nem nova dependência de sistema/FFmpeg: as bibliotecas de renderização são instaladas pelo npm.

O limite conservador de 3 imagens por chamada segue o [cartão do modelo `qwen/qwen3.6-27b`](https://console.groq.com/docs/model/qwen/qwen3.6-27b), embora o guia geral de visão mencione 5. PDFs multipágina exigem mais chamadas à Groq e consomem mais cota; a síntese não garante transcrição integral ou leitura perfeita. A geração tem limite de **800 tokens de saída por chamada**, com **60 segundos por requisição à IA** e **retries=0**. Esse timeout não é um prazo total para um PDF que requer várias chamadas. O limite de saída não elimina as cotas de entrada, visão ou tokens por minuto da conta. Consulte a [documentação Groq](https://console.groq.com/docs/overview), [transcrição](https://console.groq.com/docs/speech-to-text) e [visão](https://console.groq.com/docs/vision).

### Estado local, falhas e privacidade

O SQLite guarda as credenciais do dispositivo e chaves Signal, os pedidos por áudio aceitos para processamento durável/deduplicação e as respostas textuais. A sessão do agente recupera as **10 últimas rodadas textuais concluídas** (transcrição do pedido e resposta, até 20 itens); não é o histórico geral do WhatsApp nem um cadastro de negócio. Esse limite de contexto não apaga automaticamente comandos antigos da base. Os anexos não compõem uma biblioteca permanente de arquivos do produto.

Comandos ainda pendentes sobrevivem ao reinício. Um processamento interrompido ou envio de resultado incerto é marcado como falho: **não há repetição automática de chamadas ao modelo nem reenvio cego de mensagens**. Se houver dúvida, confira a conversa antes de fazer um novo pedido. A reconexão do socket não significa repetir a inferência ou garantir entrega exatamente uma vez.

- `.env` e `data/` ficam fora do Git. O banco e seu diretório usam permissões privadas; isso **não é criptografia em repouso**. Proteja a máquina, a chave e os backups; copiar a sessão pode expor a sua conta. Se mudar o caminho do banco, mantenha-o privado e fora do versionamento.
- Credenciais e corpos de mensagens não devem aparecer em logs ou relatórios de erro. O tracing do Agents SDK é desativado; isso não elimina o tratamento de dados pela API Groq quando você envia um comando. Considere as políticas de dados aplicáveis à sua conta Groq.
- A inferência/transcrição usa somente a Groq e está sujeita às cotas, limites de taxa e preços da conta/modelo. Os pacotes open source da OpenAI não exigem chave nem créditos OpenAI neste conector. Verificações locais ou de uma chamada isolada à API não equivalem a homologar pareamento e pedidos reais pelo WhatsApp.
- Baileys é open source (MIT), mas **não é oficial nem afiliado ao WhatsApp/Meta**. Há risco de restrição ou banimento da conta, desconexões e quebras por mudanças de protocolo, agravado pelo uso de uma release candidate. Não há garantia contra detecção, recursos de evasão ou envio em massa.

### Comandos de ajuda e verificação local

```sh
npm start -- --help
npm run typecheck
npm test
```

A ajuda pode ser consultada sem chave nem pareamento. Os comandos de verificação acima não substituem o teste real, autorizado por você, de vincular a conta e enviar um pedido por áudio. Eles não devem exigir chamadas pagas ou mensagens reais para rodar. Veja em [ARQUITETURA.md](ARQUITETURA.md) os limites do conector e o desenho futuro de gestão.

---

## Produto completo — escopo oficial planejado

As seções a seguir preservam a visão do produto. **As sete funcionalidades e o dashboard ainda não estão implementados neste MVP conversacional.**

## 1. Descrição do projeto

A SofIA transforma informações produzidas durante o trabalho — áudios, mensagens de texto, fotos, documentos e imagens — em registros organizados e ações de gestão para prestadores de serviços, profissionais autônomos e pequenos negócios.

Em vez de exigir o preenchimento de formulários e planilhas, a solução utiliza o **WhatsApp como principal interface operacional**. Um **Web Dashboard** complementa a operação com uma visão consolidada de clientes, obras, materiais, estoque, orçamentos e fluxo financeiro.

A proposta é levar recursos de ERP e CRM à rotina do profissional, reduzindo a barreira de adoção de sistemas tradicionais de gestão.

## 2. Público-alvo

### Público primário

Profissionais autônomos, MEIs, microempreendedores e pequenos empreiteiros que prestam serviços manuais, de manutenção e pequenas obras: pedreiros, pintores, carpinteiros, eletricistas, encanadores, gesseiros, mecânicos e técnicos de manutenção.

### Público secundário

Pequenas equipes familiares, mestres de obras, supervisores de serviços, auxiliares administrativos e profissionais responsáveis por orçamentos e organização financeira.

### Perfil de uso

Rotina predominantemente operacional e de campo, pouco tempo para atividades administrativas e uso frequente do WhatsApp com clientes e fornecedores. A solução prioriza voz e imagem e reduz a necessidade de digitação extensa, múltiplos cadastros e navegação por interfaces complexas.

## 3. Problemas que a solução busca resolver

| Problema | Resposta proposta |
| --- | --- |
| Falta de controle de materiais e estoque | Estruturar compras, comprovantes e consumo de insumos por serviço. |
| Perda de informações no WhatsApp | Organizar especificações, preços, fotos e instruções por cliente e trabalho. |
| Sobrecarga administrativa | Aproveitar os registros feitos durante o trabalho para reduzir o retrabalho posterior. |
| Orçamentos pouco profissionais e perda de oportunidades | Gerar PDFs padronizados e acompanhar propostas e follow-ups. |
| Dificuldade de adoção de ERPs e CRMs tradicionais | Usar comandos naturais no WhatsApp em vez de depender de formulários e menus. |

## 4. Arquitetura e meio de atuação do produto completo

| Camada | Responsabilidade no produto |
| --- | --- |
| WhatsApp — interface operacional | Receber voz, texto, fotos, notas fiscais, recibos, imagens do local de trabalho e documentos. |
| Agente multimodal de IA — inteligência | Transcrever áudios, analisar conteúdos, extrair e classificar informações, consultar e atualizar dados por ferramentas e gerar documentos. |
| Web Dashboard — interface de gestão | Exibir serviços, clientes, orçamentos, estoque, finanças, histórico, indicadores e alertas. |

O painel web não substitui a conversa no WhatsApp. A separação técnica entre canal, agente e regras de negócio está detalhada na [proposta de arquitetura](ARQUITETURA.md).

## 5. Funcionalidades principais — planejadas

### 5.1. Gerador inteligente de orçamentos por voz

Interpretar o tipo de serviço, materiais, quantidades, valores, prazo, condições de pagamento e informações do cliente enviados pelo profissional. Estruturar esses dados em um **orçamento profissional em PDF**, pronto para envio ao cliente.

### 5.2. Controle inteligente de estoque por voz ou imagem

Interpretar fotos de notas fiscais, cupons e recibos para identificar materiais, quantidades, valores, data da compra e fornecedor. Atualizar o estoque e associar os materiais à respectiva obra ou serviço.

Também deve aceitar registros por voz, como: “Comprei 20 metros de fio de 2,5 mm para a obra da Ana.”

### 5.3. Gestão inteligente de clientes

Centralizar nome e contato, endereço, serviços, orçamentos, datas, materiais utilizados, valores, status, histórico de comunicação, fotos e registros da execução.

Gerar lembretes para retornos, visitas, pagamentos e acompanhamento de orçamentos enviados.

### 5.4. Alertas inteligentes de materiais e desperdício

Identificar materiais próximos de acabar, consumo acima da estimativa, divergências entre compras e utilização, necessidade de reposição e indícios de desperdício.

Com o acúmulo de registros, utilizar o histórico dos serviços para melhorar as estimativas de consumo de trabalhos futuros.

### 5.5. Kanban inteligente de obras e serviços

Apresentar os trabalhos no painel web com o fluxo descrito no documento oficial:

**Aguardando visita → Orçamento → Aguardando aprovação → Em execução → Concluído**

Atualizar o status a partir das interações no WhatsApp. Por exemplo, “Comecei hoje a reforma da cozinha da Ana” deve permitir identificar o serviço correspondente e atualizar seu andamento.

### 5.6. Diário de bordo multimodal

Organizar **fotos, vídeos, áudios e mensagens** por cliente, obra e data, mantendo um histórico cronológico da execução.

O diário deve apoiar o acompanhamento do progresso, o registro de etapas e alterações solicitadas pelo cliente, a comprovação dos serviços, a prestação de contas e a geração de relatórios de execução.

### 5.7. Controle financeiro simplificado

Organizar entradas e saídas relacionadas aos serviços, incluindo receita por serviço, custos com materiais, pagamentos recebidos, valores pendentes, margem estimada, fluxo de caixa e despesas por obra.

Transformar mensagens como “o cliente me pagou R$ 2.000 hoje” em registros financeiros estruturados, sem depender do preenchimento manual de planilhas.

## 6. Diferencial da solução

A SofIA se adapta à rotina existente em vez de exigir que o profissional mude seu comportamento para alimentar um sistema.

**Comunicação natural + IA multimodal + automação + gestão empresarial:** um “ERP invisível” que organiza informações e executa ações nos bastidores, enquanto o profissional continua trabalhando e se comunicando pelo WhatsApp.
