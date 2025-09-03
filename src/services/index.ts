import { Diagnostics } from '../utils/diagnostics';
import { GitignoreService } from './gitignoreService';
import { FileScanner } from './fileScanner';
import { ContentProcessor } from './contentProcessor';
import { TokenAnalyzer } from './tokenAnalyzer';
import * as vscode from 'vscode';

export class Services {
    public diagnostics: Diagnostics;
    public gitignoreService: GitignoreService;
    public fileScanner: FileScanner;
    public contentProcessor: ContentProcessor;
    public tokenAnalyzer: TokenAnalyzer;
    public digestGenerated: vscode.EventEmitter<any>;

    public globalStorageUri: vscode.Uri;

    constructor(globalStorageUri: vscode.Uri) {
        this.globalStorageUri = globalStorageUri;
        this.diagnostics = new Diagnostics('info');
        this.gitignoreService = new GitignoreService();
        this.fileScanner = new FileScanner(this.gitignoreService, this.diagnostics);
        this.contentProcessor = new ContentProcessor();
        this.tokenAnalyzer = new TokenAnalyzer();
        this.digestGenerated = new vscode.EventEmitter<any>();
    }
}
