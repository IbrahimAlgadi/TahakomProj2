# FTP Image Transfer Service - Activity Diagram

## Overview
This diagram shows the main workflow of the FTP Image Transfer Service (`autoFTPImageTransferService.js`), which handles automatic transfer of image files via FTP protocol.

## Activity Diagram

```mermaid
flowchart TD
    A[Service Start] --> B[Initialize Database Pool]
    B --> C[Initialize Redis Clients]
    C --> D[Initialize FTP Services]
    D --> E[Load Initial Configuration]
    E --> F[Subscribe to Redis Events]
    F --> G[Start Consumer Loop]
    
    G --> H{Auto Transfer Active?}
    H -->|No| I[Pause Active Jobs]
    I --> J[Sleep 5s]
    J --> G
    
    H -->|Yes| K{FTP Connected & Ready?}
    K -->|No| L[Log FTP Not Ready]
    L --> M[Sleep 5s]
    M --> G
    
    K -->|Yes| N[Get or Create Active Job]
    N --> O{Active Job Exists?}
    O -->|No| P[Log No Active Job]
    P --> Q[Sleep 2s]
    Q --> G
    
    O -->|Yes| R[Update FTP Config]
    R --> S[Get Pending Files - Batch 50]
    S --> T{Files Available?}
    T -->|No| U[Sleep 3s]
    U --> G
    
    T -->|Yes| V[Start Batch Processing]
    V --> W[Initialize Counters]
    W --> X[For Each File in Batch]
    
    X --> Y{Transfer Conditions Met?}
    Y -->|No| Z[Log Stop Reason]
    Z --> AA[Break Loop]
    
    Y -->|Yes| BB{Supported Image Format?}
    BB -->|No| CC[Handle Unsupported Format]
    CC --> DD[Continue to Next File]
    
    BB -->|Yes| EE[Process Image File via FTP]
    EE --> FF{Transfer Successful?}
    FF -->|Yes| GG[Increment Processed Count]
    GG --> HH[Log Progress Every 5 Files]
    HH --> II[Small Delay 100ms]
    II --> DD
    
    FF -->|No| JJ[Increment Failed Count]
    JJ --> KK{File Not Found Error?}
    KK -->|Yes| LL[Mark as Failed]
    LL --> DD
    
    KK -->|No| MM{FTP Connection Error?}
    MM -->|Yes| NN[Set FTP Disconnected]
    NN --> OO[Handle Transfer Error]
    OO --> AA
    
    MM -->|No| PP[Handle with Retry Logic]
    PP --> DD
    
    DD --> QQ{More Files?}
    QQ -->|Yes| X
    QQ -->|No| AA
    
    AA --> RR[Calculate Duration & Throughput]
    RR --> SS[Update & Publish Metrics]
    SS --> TT[Check Completed Jobs]
    TT --> UU[Sleep Based on Processing]
    UU --> G
    
    %% Configuration Updates Branch
    VV[Redis Config Update] --> WW[Parse Message]
    WW --> XX[Update Transfer State]
    XX --> YY{Transfer State Changed?}
    YY -->|Activated| ZZ[Resume Paused Jobs]
    YY -->|Deactivated| AAA[Pause Active Jobs]
    YY -->|No Change| BBB[Update FTP Config]
    ZZ --> BBB
    AAA --> BBB
    
    %% Error Handling Branch
    CCC[Service Error] --> DDD[Log Error Details]
    DDD --> EEE{FTP Connection Error?}
    EEE -->|Yes| FFF[Mark FTP Disconnected]
    FFF --> GGG[Disconnect FTP]
    EEE -->|No| HHH[Continue Processing]
    GGG --> HHH
    HHH --> III[Sleep 10s on Error]
    III --> G
    
    %% Graceful Shutdown
    JJJ[SIGINT Signal] --> KKK[Cleanup FTP Transfer Manager]
    KKK --> LLL[Cleanup Image Processor]
    LLL --> MMM[Exit Process]
    
    %% Styling
    classDef startEnd fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef process fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef error fill:#ffebee,stroke:#c62828,stroke-width:2px
    
    class A,MMM startEnd
    class B,C,D,E,F,R,S,V,W,EE,RR,SS,TT,KKK,LLL process
    class H,K,O,T,Y,BB,FF,KK,MM,QQ,YY,EEE decision
    class CC,JJ,NN,OO,CCC,DDD,FFF,GGG error
```

## Key Components

### Main Processing Flow
1. **Service Initialization**: Sets up database, Redis connections, and FTP services
2. **Configuration Management**: Loads and monitors FTP configuration changes
3. **Consumer Loop**: Main processing loop that handles file transfer batches
4. **File Processing**: Validates and transfers individual image files via FTP
5. **Error Handling**: Manages different types of errors with appropriate recovery strategies

### Key Decision Points
- **Auto Transfer Active**: Checks if the service should be processing files
- **FTP Connection Ready**: Validates FTP connection status before processing
- **File Format Validation**: Ensures only supported image formats are processed
- **Error Type Classification**: Different handling for file not found vs FTP connection errors

### Metrics and Monitoring
- Real-time progress tracking during batch processing
- Transfer statistics (processed count, failed count, throughput)
- Redis metrics publishing for dashboard integration
- Job completion status tracking

### Configuration Updates
- Redis pub/sub for real-time configuration changes
- Dynamic FTP configuration reloading
- Transfer activation/deactivation handling

## Error Recovery Strategies
1. **File Not Found**: Mark as failed and continue
2. **FTP Connection Errors**: Disconnect FTP and retry in next cycle
3. **General Errors**: Apply retry logic with exponential backoff
4. **Service Errors**: Longer delays before retry (10s)

## Performance Considerations
- Batch processing (50 files per batch)
- Small delays between FTP uploads (100ms) to prevent server overload
- Progress logging every 5 files for large batches
- Configurable retry strategies for failed transfers
