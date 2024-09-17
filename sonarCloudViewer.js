const vscode = acquireVsCodeApi();
const severityFilter = document.getElementById('severity-filter');
const filesContainer = document.getElementById('files-container');
const noIssuesMessage = document.getElementById('no-issues-message');
const fileSearch = document.getElementById('file-search');
const clearFilterBtn = document.getElementById('clear-filter-btn');

let lastReceivedFilePath = '';
let availableSeverities = new Set();

function initializeSeverityCheckboxes() {
    const severities = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];

    // Determine quais severidades estão disponíveis
    const files = filesContainer.getElementsByClassName('file');
    Array.from(files).forEach(file => {
        const issues = file.getElementsByClassName('issue');
        Array.from(issues).forEach(issue => {
            availableSeverities.add(issue.dataset.severity);
        });
    });

    const checkboxesHtml = severities.map(severity => {
        const isAvailable = availableSeverities.has(severity);
        return `
            <label class="severity-checkbox ${isAvailable ? '' : 'disabled'}">
                <input type="checkbox" value="${severity}" ${isAvailable ? 'checked' : 'disabled'}>
                <span class="checkmark"></span>
                ${severity}
            </label>
        `;
    }).join('');

    severityFilter.innerHTML = checkboxesHtml;

    // Adiciona evento de click para cada label do checkbox
    severityFilter.querySelectorAll('.severity-checkbox').forEach(label => {
        label.addEventListener('click', handleSeverityChange);
    });
}

function handleSeverityChange(event) {
    const checkbox = event.currentTarget.querySelector('input[type="checkbox"]');
    if (checkbox.disabled) return;

    const isChecked = checkbox.checked;
    const checkedCheckboxes = severityFilter.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)');

    if (checkedCheckboxes.length === 1 && isChecked) {
        event.preventDefault();
        return;
    }

    checkbox.checked = !isChecked;
    filterIssues();
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');
}

function createFlexiblePathRegex(path) {
    path = path.replace(/\\\\/g, '/');
    const parts = path.split(/[\\/]+/).filter(Boolean);
    const pattern = parts.map(part => '(?=.*' + escapeRegExp(part) + ')').join('');
    return new RegExp(pattern, 'i');
}

function clearFilter() {
    fileSearch.value = '';
    severityFilter.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(checkbox => {
        checkbox.checked = true;
    });
    filterIssues();
}

function filterIssues() {
    const searchTerm = fileSearch.value.trim();
    const searchRegex = createFlexiblePathRegex(searchTerm);
    const files = filesContainer.getElementsByClassName('file');
    let hasVisibleIssues = false;
    
    const selectedSeverities = Array.from(severityFilter.querySelectorAll('input:checked')).map(cb => cb.value);
    
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
            });
            
            file.classList.toggle('hidden', !fileHasVisibleIssues);
        } else {
            file.classList.add('hidden');
        }
    });

    noIssuesMessage.style.display = hasVisibleIssues ? 'none' : 'block';
    noIssuesMessage.textContent = hasVisibleIssues ? '' : 'Nenhuma issue encontrada para os filtros selecionados.';
}

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

function updateFileContent(filePath) {
    lastReceivedFilePath = filePath;
    fileSearch.value = lastReceivedFilePath;
    filterIssues();
}

// Event listeners
clearFilterBtn.addEventListener('click', clearFilter);
fileSearch.addEventListener('input', filterIssues);

window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'updateCurrentFilePath') {
        updateFileContent(message.filePath);
    }
});

vscode.postMessage({ type: 'requestCurrentFilePath' });

// Inicialização
initializeSeverityCheckboxes();
filterIssues();