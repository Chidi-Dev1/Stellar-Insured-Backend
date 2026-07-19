import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { create, IPFSHTTPClient } from 'ipfs-http-client';
import * as fs from 'fs';
import * as path from 'path';
import { QUEUE_NAMES, IpfsPinJobData } from '../notification/constants/queue.constants';

let sharp: typeof import('sharp') | undefined;
try {
  sharp = require('sharp');
} catch (err) {
  // sharp native dependency not available
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private ipfs: IPFSHTTPClient;

  constructor(
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_NAMES.IPFS_PIN)
    private readonly ipfsPinQueue: Queue<IpfsPinJobData>,
  ) {
    const ipfsHost = this.config.get<string>('storage.ipfs.host') || 'localhost';
    const ipfsPort = this.config.get<number>('storage.ipfs.port') || 5001;
    const ipfsProtocol = this.config.get<string>('storage.ipfs.protocol') || 'http';
    
    this.ipfs = create({
      host: ipfsHost,
      port: ipfsPort,
      protocol: ipfsProtocol,
    });
  }

  /**
   * Enqueue an IPFS pin job so the (potentially slow) IPFS call happens
   * off-request. Returns immediately after enqueueing.
   */
  async queuePinProjectMetadata(
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.ipfsPinQueue.add(
      { metadata },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log('Queued IPFS pin job for project metadata');
  }

  async pinProjectMetadata(metadata: Record<string, unknown>): Promise<string> {
    try {
      const cid = await this.ipfs.add(JSON.stringify(metadata));
      this.logger.log(`Pinned metadata with CID: ${cid.path}`);
      return cid.path;
    } catch (error) {
      this.logger.error('Failed to pin metadata to IPFS', error);
      throw new ServiceUnavailableException('Failed to pin metadata to IPFS');
    }
  }

  async optimizeImage(imagePath: string, width: number, height: number): Promise<Buffer> {
    if (!sharp) {
      this.logger.error('Sharp library is not available. Native dependencies may be missing.');
      throw new ServiceUnavailableException(
        'Image optimization service is unavailable. Native dependencies are missing.',
      );
    }

    const resolvedPath = path.resolve(imagePath);
    if (!fs.existsSync(resolvedPath)) {
      this.logger.warn(`Image path does not exist: ${resolvedPath}`);
      throw new BadRequestException(`Image path does not exist: ${imagePath}`);
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new BadRequestException(`Path is not a file: ${imagePath}`);
    }

    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'];
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException(
        `Invalid image format: ${ext}. Allowed: ${allowedExtensions.join(', ')}`,
      );
    }

    try {
      const optimizedImage = await sharp(resolvedPath)
        .resize(width, height, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
      this.logger.log(`Optimized image: ${resolvedPath} -> ${width}x${height}`);
      return optimizedImage;
    } catch (error) {
      this.logger.error(`Failed to optimize image: ${resolvedPath}`, error);
      throw new BadRequestException('Failed to optimize image. Ensure the file is a valid image.');
    }
  }

  async verifyIPFSHash(hash: string): Promise<boolean> {
    try {
      const chunks = [];
      for await (const chunk of this.ipfs.cat(hash)) {
        chunks.push(chunk);
      }
      return chunks.length > 0;
    } catch (error) {
      this.logger.warn(`IPFS hash verification failed for ${hash}`, error);
      return false;
    }
  }
}
