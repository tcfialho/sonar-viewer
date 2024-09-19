// Inicializa a API do VS Code
const vscode = acquireVsCodeApi();

// Elementos do DOM
const severityFilter = document.getElementById('severity-filter');
const filesContainer = document.getElementById('files-container');
const noIssuesMessage = document.getElementById('no-issues-message');
const fileSearch = document.getElementById('file-search');
const clearFilterBtn = document.getElementById('clear-filter-btn');

// Variáveis de estado
let lastReceivedFilePath = '';
let lastFilteredFilePath = ''; // Nova variável para armazenar o último arquivo filtrado
let availableSeverities = new Set();
let isUpdatingFile = false;
let userHasTyped = false;
let preventUpdate = false;
let filterDebounceTimer;
const DEBOUNCE_DELAY = 300; // milissegundos

/**
 * Inicializa os checkboxes de severidade com base nas issues disponíveis.
 * Esta função é chamada uma vez no início para configurar os filtros de severidade.
 */
function initializeSeverityCheckboxes() {
    const severities = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
    availableSeverities.clear();

    // Determina quais severidades estão presentes nas issues
    Array.from(filesContainer.getElementsByClassName('file')).forEach(file => {
        Array.from(file.getElementsByClassName('issue')).forEach(issue => {
            availableSeverities.add(issue.dataset.severity);
        });
    });

    // Cria os checkboxes HTML para cada severidade
    const checkboxesHtml = severities.map(severity => {
        const isAvailable = availableSeverities.has(severity);
        return `
            <label class="severity-checkbox ${isAvailable ? '' : 'disabled'}">
                <input type="checkbox" value="${severity}" ${isAvailable ? 'checked' : ''} ${isAvailable ? '' : 'disabled'}>
                <span class="checkmark"></span>
                ${severity}
            </label>
        `;
    }).join('');

    severityFilter.innerHTML = checkboxesHtml;

    // Adiciona eventos de clique para cada checkbox
    severityFilter.querySelectorAll('.severity-checkbox').forEach(label => {
        label.addEventListener('click', handleSeverityChange);
    });
}

/**
 * Gerencia a mudança de estado dos checkboxes de severidade.
 * Garante que pelo menos um checkbox esteja sempre selecionado.
 * @param {Event} event - O evento de clique no checkbox
 */
function handleSeverityChange(event) {
    const checkbox = event.currentTarget.querySelector('input[type="checkbox"]');
    if (checkbox.disabled) return;

    const isChecked = checkbox.checked;
    const checkedCheckboxes = severityFilter.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)');

    // Impede que o último checkbox seja desmarcado
    if (checkedCheckboxes.length === 1 && isChecked) {
        event.preventDefault();
        return;
    }

    checkbox.checked = !isChecked;
    isUpdatingFile = false;  // Indica que esta é uma interação do usuário
    filterIssues();
}

/**
 * Escapa caracteres especiais em uma string para uso em expressões regulares.
 * @param {string} string - A string a ser escapada
 * @return {string} A string com caracteres especiais escapados
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cria uma expressão regular flexível para busca de caminhos de arquivo.
 * Permite correspondência parcial e ignora case.
 * @param {string} path - O caminho de arquivo a ser buscado
 * @return {RegExp} A expressão regular para busca de caminhos
 */
function createFlexiblePathRegex(path) {
    path = path.replace(/\\\\/g, '/');
    const parts = path.split(/[\\/]+/).filter(Boolean);
    const pattern = parts.map(part => '(?=.*' + escapeRegExp(part) + ')').join('');
    return new RegExp(pattern, 'i');
}

/**
 * Limpa todos os filtros aplicados, resetando a busca e os checkboxes de severidade.
 * Armazena o último arquivo filtrado antes de limpar.
 */
function clearFilter() {
    preventUpdate = true;
    lastFilteredFilePath = fileSearch.value.trim(); // Armazena o último arquivo filtrado
    fileSearch.value = '';
    userHasTyped = false;  // Reseta o flag de digitação do usuário
    enableAllAvailableSeverities();
    filterIssues();
    setTimeout(() => {
        preventUpdate = false;
    }, 600);
}

/**
 * Habilita todos os checkboxes de severidade disponíveis.
 */
function enableAllAvailableSeverities() {
    severityFilter.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        const isAvailable = availableSeverities.has(checkbox.value);
        checkbox.checked = isAvailable;
        checkbox.disabled = !isAvailable;
        checkbox.closest('.severity-checkbox').classList.toggle('disabled', !isAvailable);
    });
}

/**
 * Filtra as issues com base nos critérios de busca e severidade selecionados.
 * Esta é a função principal de filtragem que atualiza a visibilidade das issues.
 */
function filterIssues() {
    console.log('Filtrando issues');
    const searchTerm = fileSearch.value.trim();
    const searchRegex = createFlexiblePathRegex(searchTerm);
    const files = filesContainer.getElementsByClassName('file');
    let hasVisibleIssues = false;
    
    const selectedSeverities = Array.from(severityFilter.querySelectorAll('input:checked')).map(cb => cb.value);
    const severityCounts = {};
    
    Array.from(files).forEach(file => {
        const filePath = file.dataset.filePath;
        const fileMatchesSearch = searchTerm === '' || searchRegex.test(filePath);
        
        if (fileMatchesSearch) {
            const issues = file.getElementsByClassName('issue');
            let fileHasVisibleIssues = false;
            
            Array.from(issues).forEach(issue => {
                const issueSeverity = issue.dataset.severity;
                const issueVisible = selectedSeverities.includes(issueSeverity);
                issue.classList.toggle('hidden', !issueVisible);
                if (issueVisible) {
                    fileHasVisibleIssues = true;
                    hasVisibleIssues = true;
                }
                severityCounts[issueSeverity] = (severityCounts[issueSeverity] || 0) + 1;
            });
            
            file.classList.toggle('hidden', !fileHasVisibleIssues);
        } else {
            file.classList.add('hidden');
        }
    });

    updateSeverityCheckboxes(severityCounts);

    noIssuesMessage.style.display = hasVisibleIssues ? 'none' : 'block';
    noIssuesMessage.textContent = hasVisibleIssues ? '' : 'Nenhuma issue encontrada para os filtros selecionados.';
}

/**
 * Atualiza o estado dos checkboxes de severidade com base nas issues visíveis.
 * @param {Object} severityCounts - Contagem de issues por severidade
 */
function updateSeverityCheckboxes(severityCounts) {
    severityFilter.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        const severity = checkbox.value;
        const hasIssues = severityCounts[severity] > 0;
        checkbox.disabled = !hasIssues;
        checkbox.closest('.severity-checkbox').classList.toggle('disabled', !hasIssues);
        if (!hasIssues && isUpdatingFile) {
            checkbox.checked = false;
        }
    });

    // Garante que pelo menos um checkbox esteja marcado
    const checkedCheckboxes = severityFilter.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)');
    if (checkedCheckboxes.length === 0) {
        const firstEnabledCheckbox = severityFilter.querySelector('input[type="checkbox"]:not(:disabled)');
        if (firstEnabledCheckbox) {
            firstEnabledCheckbox.checked = true;
        }
    }
}

/**
 * Copia o código de uma issue para a área de transferência.
 * @param {HTMLElement} button - O botão de cópia clicado
 */
function copyCode(button) {
    const codeContainer = button.parentElement;
    const codeElement = codeContainer.querySelector('code');
    const textArea = document.createElement('textarea');
    textArea.value = codeElement.innerText;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    
    const originalText = button.textContent;
    button.textContent = '✔️';
    button.style.opacity = '1';
    setTimeout(() => {
        button.textContent = originalText;
        button.style.opacity = '0.7';
    }, 2000);
}

/**
 * Atualiza o conteúdo da visualização quando um novo arquivo é selecionado.
 * Não sobrescreve o conteúdo da caixa de busca se o usuário digitou algo manualmente.
 * @param {string} filePath - O caminho do arquivo selecionado
 */
function updateFileContent(filePath) {
    if (filePath === lastReceivedFilePath && fileSearch.value.trim() !== '') {
        return; // Evita atualizações desnecessárias
    }
    lastReceivedFilePath = filePath;
    
    // Verifica se o arquivo clicado é o mesmo que estava sendo filtrado antes de limpar
    if (filePath === lastFilteredFilePath) {
        fileSearch.value = filePath;
        userHasTyped = false; // Permite que o campo seja atualizado automaticamente no futuro
        lastFilteredFilePath = ''; // Reseta o último arquivo filtrado
    } else if (!userHasTyped) {
        fileSearch.value = filePath;
    }
    
    isUpdatingFile = true;  // Indica que estamos atualizando devido a uma mudança de arquivo
    enableAllAvailableSeverities();
    filterIssues();
}

// Event listeners
clearFilterBtn.addEventListener('click', clearFilter);

fileSearch.addEventListener('input', () => {
    userHasTyped = true;
    filterIssues();
});

fileSearch.addEventListener('focus', () => {
    // Quando o usuário foca na caixa de busca, consideramos que ele pode estar prestes a digitar
    userHasTyped = true;
});

fileSearch.addEventListener('blur', () => {
    // Quando o usuário sai da caixa de busca, verificamos se ela está vazia
    if (fileSearch.value.trim() === '') {
        // Se estiver vazia, resetamos o estado para permitir o preenchimento automático novamente
        userHasTyped = false;
    }
});

// Listener para mensagens do VS Code
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'updateCurrentFilePath') {
        if (!preventUpdate) {
            updateFileContent(message.filePath);
        }
    }
});

// Solicita o caminho do arquivo atual ao VS Code
vscode.postMessage({ type: 'requestCurrentFilePath' });

// Inicialização
initializeSeverityCheckboxes();
filterIssues();