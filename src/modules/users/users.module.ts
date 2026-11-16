import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  NoopUserActivationHook,
  UserActivationHook,
} from './user-activation.hook';
import { User } from './user.entity';
import { UsersService } from './users.service';

/**
 * Модуль пользователей. Владеет таблицей `users`. Другие модули работают
 * с пользователями только через `UsersService`, а не через репозиторий
 * напрямую (граница модуля, глава 0.3 «модульный монолит»).
 */
@Module({
  // forFeature регистрирует Repository<User> для внедрения через @InjectRepository(User).
  imports: [TypeOrmModule.forFeature([User])],
  providers: [
    UsersService,
    // Точка расширения для RBAC (1.1): здесь поменяется только useClass/useExisting.
    { provide: UserActivationHook, useClass: NoopUserActivationHook },
  ],
  exports: [UsersService],
})
export class UsersModule {}
