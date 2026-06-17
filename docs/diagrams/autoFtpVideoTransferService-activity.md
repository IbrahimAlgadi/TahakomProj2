# FTP Video Transfer Service - Activity Diagram

## Overview
This diagram shows the main workflow of the FTP Video Transfer Service (`autoFtpVideoTransferService.js`), which handles automatic video processing, creation, and transfer via FTP protocol with advanced scheduling and connection management.

## Activity Diagram

```mermaid
flowchart TD
    A[Service Start] --> B[Initialize Database Pool]
    B --> C[Initialize Redis Connections]
    C --> D[Ensure FTP Video Temp Directory]
    D --> E[Load FTP Configuration]
    E --> F[Initialize External Services]
    F --> G[Subscribe to Redis Events]
    G --> H[Load Service Configuration]
    H --> I[Emit Start Event]
    
    I --> J[Start Processing Loop]
    I --> K[Start Buffer Monitoring Loop]
    I --> L[Start FTP Connection Monitoring]
    
    %% Main Processing Loop
    J --> M{Should Stop?}
    M -->|Yes| N[End Processing]
    
    M -->|No| O{FTP Video Transfer Enabled?}
    O -->|No| P[Log Transfer Disabled]
    P --> Q[Sleep 2s]
    Q --> J
    
    O -->|Yes| R{Is Processing?}
    R -->|Yes| S[Sleep 2s]
    S --> J
    
    R -->|No| T[Set Processing True]
    T --> U{FTP Transfer Enabled in Config?}
    U -->|No| V[Log FTP Transfer Disabled]
    V --> W[Set Processing False]
    W --> X[Sleep 5s]
    X --> J
    
    U -->|Yes| Y{FTP Config Available?}
    Y -->|No| Z[Log FTP Config Not Available]
    Z --> W
    
    Y -->|Yes| AA{Should Start Transfer (Schedule)?}
    AA -->|No| BB[Log Not in Scheduled Time]
    BB --> W
    
    AA -->|Yes| CC{FTP Connected?}
    CC -->|No| DD[Log FTP Not Connected]
    DD --> W
    
    CC -->|Yes| EE[Get Existing Uncompleted FTP Jobs]
    EE --> FF{FTP Jobs Found?}
    FF -->|Yes| GG[Get Newest FTP Job]
    GG --> HH[Handle FTP Job Processing]
    
    FF -->|No| II[Check FTP File Availability]
    II --> JJ{Files Available for FTP?}
    JJ -->|No| KK[Log No Files Available]
    KK --> W
    
    JJ -->|Yes| LL[Create New FTP Job with UUID]
    LL --> MM[Log New FTP Job Created]
    MM --> HH
    
    HH --> NN[Process All Cameras for FTP Job]
    
    %% Single Camera FTP Processing
    NN --> OO[For Each Camera]
    OO --> PP{Video in FTP Transfer Queue?}
    PP -->|Yes| QQ[Check FTP Video Status]
    QQ --> RR{Status = Pending?}
    RR -->|Yes| SS[Emit Start FTP Transfer]
    RR -->|No| TT[Continue to Next Camera]
    
    PP -->|No| UU[Get Camera File Counts from FTP Buffer]
    UU --> VV{Enough Files for FTP Video?}
    VV -->|No| WW{Pending FTP Records Available?}
    WW -->|Yes| XX[Process Pending FTP Records]
    XX --> YY[Convert Files for FTP Buffer]
    WW -->|No| ZZ[Request Additional Files for FTP]
    ZZ --> AAA[Add to FTP Buffer as Pending]
    AAA --> YY
    
    VV -->|Yes| BBB{Enough Converted FTP Files?}
    BBB -->|Yes| CCC[Group Files by Camera in FTP Buffer]
    BBB -->|No| YY
    
    CCC --> DDD{Enough Grouped FTP Files?}
    DDD -->|No| YY
    DDD -->|Yes| EEE[Create Video from FTP Buffer]
    EEE --> FFF[Add Video to FTP Transfer Queue]
    FFF --> GGG[Mark Camera as Processed]
    GGG --> HHH[Update FTP Job Stats]
    HHH --> SS
    
    SS --> TT
    TT --> III{More Cameras?}
    III -->|Yes| OO
    III -->|No| JJJ[All Cameras Processed]
    
    YY --> KKK[Update FTP Job Status to Pending]
    KKK --> TT
    
    JJJ --> LLL[Update & Publish FTP Video Metrics]
    LLL --> W
    
    %% FTP Transfer to Storage Loop (Event-driven)
    MMM[Start FTP Transfer Event] --> NNN{Should Stop?}
    NNN -->|Yes| OOO[End FTP Transfer]
    
    NNN -->|No| PPP{FTP Transfer Paused?}
    PPP -->|Yes| QQQ[Log FTP Transfer Disabled]
    QQQ --> OOO
    
    PPP -->|No| RRR{FTP Transfer Already Running?}
    RRR -->|Yes| SSS[Log FTP Transfer Already Running]
    SSS --> OOO
    
    RRR -->|No| TTT[Set FTP Transfer Running True]
    TTT --> UUU{FTP Connected?}
    UUU -->|No| VVV[Log FTP Not Connected]
    VVV --> WWW[Set FTP Transfer Running False]
    WWW --> OOO
    
    UUU -->|Yes| XXX[Get Pending FTP Transfer File]
    XXX --> YYY{FTP File Available?}
    YYY -->|No| WWW
    
    YYY -->|Yes| ZZZ[Transfer File via FTP]
    ZZZ --> AAAA{FTP Transfer Successful?}
    AAAA -->|Yes| BBBB[Mark Source Files as FTP Transferred]
    BBBB --> CCCC[Cleanup Temp FTP Video File]
    CCCC --> DDDD[Check FTP Job Completion]
    DDDD --> EEEE[Update FTP Video Metrics]
    EEEE --> WWW
    
    AAAA -->|No| FFFF[Handle FTP Transfer Error]
    FFFF --> WWW
    
    %% Buffer Monitoring Loop (FTP-specific)
    K --> GGGG{Should Stop?}
    GGGG -->|Yes| HHHH[End FTP Buffer Monitoring]
    
    GGGG -->|No| IIII[Check Ready Groups in FTP Buffer]
    IIII --> JJJJ[Sleep 30s]
    JJJJ --> K
    
    %% FTP Connection Monitoring Loop
    L --> KKKK{Should Stop?}
    KKKK -->|Yes| LLLL[End FTP Connection Monitoring]
    
    KKKK -->|No| MMMM{Time for FTP Connection Test?}
    MMMM -->|No| NNNN[Sleep 10s]
    NNNN --> L
    
    MMMM -->|Yes| OOOO[Update Last Test Time]
    OOOO --> PPPP{FTP Transfer Manager Available?}
    PPPP -->|No| NNNN
    
    PPPP -->|Yes| QQQQ[Test FTP Connection]
    QQQQ --> RRRR{FTP Test Successful?}
    RRRR -->|Yes| SSSS[Set FTP Connected True]
    SSSS --> TTTT[Log FTP Connection Successful]
    TTTT --> NNNN
    
    RRRR -->|No| UUUU[Set FTP Connected False]
    UUUU --> VVVV[Log FTP Connection Failed]
    VVVV --> NNNN
    
    %% Configuration Updates (Redis Events)
    WWWW[FTP Config Update Event] --> XXXX[Update Service Config]
    XXXX --> YYYY[Update Current Site ID]
    YYYY --> ZZZZ[Update External FTP Services]
    ZZZZ --> AAAAA[Reload FTP Configuration]
    AAAAA --> BBBBB[Set FTP Config in Transfer Manager]
    BBBBB --> CCCCC[Update Transfer Pause State]
    
    %% Schedule Check Function
    DDDDD[Schedule Check] --> EEEEE{FTP Schedule Config Available?}
    EEEEE -->|No| FFFFF[Allow Transfer - No Schedule]
    
    EEEEE -->|Yes| GGGGG{Schedule Type?}
    GGGGG -->|Disabled| HHHHH[Block Transfer - Disabled]
    GGGGG -->|Immediate| FFFFF
    GGGGG -->|Scheduled| IIIII[Check Day of Week]
    
    IIIII --> JJJJJ{Correct Day?}
    JJJJJ -->|No| HHHHH
    JJJJJ -->|Yes| KKKKK[Check Transfer Time]
    KKKKK --> LLLLL{Within Time Window?}
    LLLLL -->|No| HHHHH
    LLLLL -->|Yes| FFFFF
    
    %% FTP Metrics Publishing
    MMMMM[FTP Metrics Update] --> NNNNN[Get Job Statistics]
    NNNNN --> OOOOO[Get Transfer Statistics]
    OOOOO --> PPPPP[Compile FTP Metrics Data]
    PPPPP --> QQQQQ[Publish to Redis FTP Video Metrics]
    QQQQQ --> RRRRR[Set Metrics with Expiry]
    
    %% Error Handling
    SSSSS[FTP Service Error] --> TTTTT[Log FTP Error Details]
    TTTTT --> UUUUU[Update FTP Error Statistics]
    UUUUU --> VVVVV[Continue FTP Processing]
    
    %% Graceful Shutdown
    WWWWW[Shutdown Signal] --> XXXXX[Stop All FTP Loops]
    XXXXX --> YYYYY[Close Redis Connections]
    YYYYY --> ZZZZZ[Close Database Pool]
    ZZZZZ --> AAAAAA[Exit FTP Service]
    
    %% Styling
    classDef startEnd fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef process fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef event fill:#e8f5e8,stroke:#2e7d32,stroke-width:2px
    classDef error fill:#ffebee,stroke:#c62828,stroke-width:2px
    classDef ftp fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    classDef metrics fill:#f1f8e9,stroke:#558b2f,stroke-width:2px
    classDef schedule fill:#fce4ec,stroke:#ad1457,stroke-width:2px
    
    class A,N,OOO,HHHH,LLLL,AAAAAA startEnd
    class B,C,D,E,F,G,H,T,LL,MM,YY,CCC,EEE,FFF,GGG,HHH,ZZZ,BBBB,CCCC,DDDD,IIII,OOOO,QQQQ,SSSS,TTTT,XXXX,YYYY,ZZZZ,AAAAA,BBBBB,NNNNN,OOOOO,PPPPP,QQQQQ,RRRRR,XXXXX,YYYYY,ZZZZZ process
    class M,O,R,U,Y,AA,CC,FF,JJ,PP,RR,VV,WW,BBB,DDD,NNN,PPP,RRR,UUU,YYY,AAAA,GGGG,KKKK,MMMM,PPPP,RRRR,EEEEE,GGGGG,JJJJJ,LLLLL decision
    class I,MMM,WWWW event
    class V,Z,DD,KK,QQQ,VVV,SSS,FFFF,UUUU,VVVV,SSSSS,TTTTT,UUUUU error
    class E,F,ZZZ,QQQQ,AAAAA,BBBBB,PPPPP,QQQQQ ftp
    class LLL,EEEE,MMMMM,NNNNN,OOOOO,PPPPP,QQQQQ,RRRRR metrics
    class AA,DDDDD,EEEEE,GGGGG,IIIII,JJJJJ,KKKKK,LLLLL,FFFFF,HHHHH schedule
```

## Key Components

### FTP Service Architecture
- **EventEmitter-based**: Similar to USB service but optimized for FTP transfers
- **FTP-Specific Services**: FtpJobManager, FtpTransferManager, FtpCompleteBufferManager
- **Connection Monitoring**: Dedicated FTP connection health checking
- **Schedule-Based Transfers**: Supports immediate, scheduled, and disabled modes

### Main Processing Flow
1. **FTP Job Management**: Creates and tracks FTP-specific video processing jobs
2. **Camera Processing**: Processes each camera with FTP buffer management
3. **FTP File Pipeline**: Request → FTP Buffer → Convert → Group → Create Video → FTP Transfer
4. **Connection Validation**: Continuous FTP connection status monitoring

### FTP Transfer Pipeline
1. **File Conversion**: Media files converted and stored in FTP-specific buffer
2. **Grouping**: Files grouped by camera using FTP buffer table
3. **Video Creation**: Groups converted to videos when threshold reached
4. **FTP Transfer**: Videos transferred via FTP protocol
5. **Cleanup**: Temporary FTP videos and completed jobs cleaned up

### FTP Connection Management
- **Periodic Testing**: Automatic FTP connection testing every 30 seconds
- **Status Tracking**: Real-time FTP connection status monitoring
- **Error Recovery**: Automatic reconnection attempts on failure
- **Configuration Reloading**: Dynamic FTP configuration updates

### Schedule Management
- **Schedule Types**: Disabled, Immediate, Scheduled
- **Time Windows**: Day of week and hour-based scheduling
- **Transfer Windows**: Configurable time windows for scheduled transfers
- **Dynamic Updates**: Real-time schedule configuration changes

### FTP-Specific Features
- **FTP Buffer Tables**: Separate buffer management for FTP operations
- **FTP Error Handling**: Specialized error handling for FTP connection issues
- **FTP Metrics**: Dedicated metrics for FTP transfer performance
- **FTP Configuration**: File-based FTP server configuration management

### Error Recovery Strategies
1. **FTP Connection Errors**: Automatic reconnection and retry logic
2. **Transfer Failures**: Retry with exponential backoff
3. **Configuration Errors**: Graceful fallback to previous valid configuration
4. **File Missing**: Skip missing files and continue processing

### Metrics and Monitoring
- **Job Metrics**: FTP-specific job tracking and completion rates
- **Transfer Metrics**: FTP transfer speed, success rates, connection status
- **Connection Metrics**: FTP server availability and response times
- **Redis Publishing**: Real-time metrics for FTP transfer dashboard

### Configuration Management
- **File-Based Config**: FTP configuration loaded from ftp-transfer.json
- **Redis Updates**: Service configuration updates via Redis pub/sub
- **Schedule Updates**: Dynamic transfer schedule configuration
- **FTP Server Settings**: Host, port, credentials, and transfer paths

## Performance Optimizations
- **Parallel Camera Processing**: Multiple cameras processed simultaneously
- **FTP Connection Pooling**: Efficient FTP connection management
- **Buffer Management**: Optimized FTP buffer operations
- **Batch Processing**: Files processed in efficient batches for FTP transfer
- **Connection Monitoring**: Proactive connection health checking prevents transfer failures
